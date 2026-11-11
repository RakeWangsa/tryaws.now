import type { Result } from "@tc/core";
import { maskPhone, normalizeBdMobile } from "@tc/core";
import { consumeRateLimits, customerRepos, type LimitRule, type OtpChallenge } from "@tc/db";
import { otpSmsText } from "../sms/otp-text";
import type { SmsProvider } from "../sms/provider";
import { assertPepper, generateCode, hashCode } from "./codes";
import type { OtpSession, SendOtpDeps } from "./deps";
import { challengeIdFor, ipSubject, phoneSubject } from "./keys";
import { OTP, OTP_IDEMPOTENCY_KEY } from "./policy";

export interface SendPhoneOtpInput {
  readonly phone: string;
  readonly ip: string;
  readonly idempotencyKey: string;
}

export interface OtpSent {
  readonly challengeId: string;
  readonly phoneMasked: string;
  readonly expiresAt: Date;
  // The issue time plus OTP.resendSeconds: the moment the timer of the page ends.
  readonly resendAt: Date;
  readonly replayed: boolean;
}

const SEND_FAILED = "otp: send failed";
const NOT_STORED = "otp: the challenge could not be stored";

// Thrown inside the transaction, so that the new challenge, the closing of the older ones and every
// increment of this send roll back. It never leaves this file.
class SendRefused extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("otp: send refused");
  }
}

type Outcome =
  | { readonly kind: "sent" }
  | { readonly kind: "conflict" }
  | { readonly kind: "replayed"; readonly challenge: OtpChallenge };

type GatewayAnswer = "ok" | "rejected" | "unavailable";

// A thrown error, a timeout and any unknown answer are "unavailable"; nothing of the error is read
// (R14). The timer is always cleared.
async function callGateway(
  sms: SmsProvider,
  to: string,
  text: string,
  timeoutMs: number,
): Promise<GatewayAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GatewayAnswer>((resolve) => {
    timer = setTimeout(() => resolve("unavailable"), timeoutMs);
  });
  const call = (async (): Promise<GatewayAnswer> => {
    try {
      const result = await sms.send(to, text);
      if (result.ok) return "ok";
      return result.reason === "rejected" ? "rejected" : "unavailable";
    } catch {
      return "unavailable";
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendPhoneOtp(
  deps: SendOtpDeps,
  session: OtpSession,
  input: SendPhoneOtpInput,
): Promise<Result<OtpSent>> {
  // 1. Configuration faults throw before anything else (R16).
  assertPepper(deps.pepper);
  if (!Array.isArray(deps.limits) || deps.limits.length === 0) {
    throw new TypeError("otp: no send limit is configured");
  }
  if (
    !deps.limits.some((rule) => rule.kind === "phone") ||
    !deps.limits.some((rule) => rule.kind === "ip")
  ) {
    throw new TypeError("otp: the send limits need a phone rule and an ip rule");
  }

  // 2. Validation before any transaction, every invalid field collected.
  const phone = normalizeBdMobile(input.phone);
  const fields: Record<string, string> = {};
  if (phone === null) fields.phone = "invalid";
  if (typeof input.idempotencyKey !== "string" || !OTP_IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    fields.idempotencyKey = "invalid";
  }
  const ipKey = ipSubject(deps.pepper, input.ip);
  if (ipKey === null) fields.ip = "invalid";
  if (phone === null || ipKey === null || Object.keys(fields).length > 0) {
    return { ok: false, error: "validation", fields };
  }

  // 3. One reading of the clock; the code and its text exist before any row or counter.
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + OTP.ttlSeconds * 1000);
  const id = challengeIdFor(deps.pepper, session.customerId, input.idempotencyKey);
  const code = generateCode(deps.randomInt);
  const codeHash = hashCode(deps.pepper, id, phone, code);
  const text = otpSmsText(session.locale, deps.numerals ?? "beng", code, OTP.ttlSeconds / 60);

  // 4. The one transaction that can refuse.
  const customerLimits = deps.limits.filter((rule) => rule.kind === "customer");
  const addressRules: LimitRule[] = deps.limits.flatMap((rule) =>
    rule.kind === "customer"
      ? []
      : [
          {
            kind: rule.kind,
            subject: rule.kind === "ip" ? ipKey : phoneSubject(deps.pepper, phone),
            action: rule.action,
            limit: rule.limit,
            windowSeconds: rule.windowSeconds,
          },
        ],
  );
  let outcome: Outcome;
  try {
    outcome = await deps.run(async (tx): Promise<Outcome> => {
      const r = customerRepos(tx, session.customerId);
      const issued = await r.otp.issue({ id, phone, codeHash, expiresAt, now });
      if (!issued.ok) {
        if (issued.error === "conflict") return { kind: "conflict" };
        throw new Error(NOT_STORED);
      }
      if (issued.replayed) return { kind: "replayed", challenge: issued.value };
      if (customerLimits.length > 0) {
        const decision = await r.rateLimits.consume(
          customerLimits.map((rule) => ({
            action: rule.action,
            limit: rule.limit,
            windowSeconds: rule.windowSeconds,
          })),
          now,
        );
        if (!decision.allowed) throw new SendRefused(decision.retryAfterSeconds);
      }
      const decision = await consumeRateLimits(tx, addressRules, now);
      if (!decision.allowed) throw new SendRefused(decision.retryAfterSeconds);
      return { kind: "sent" };
    });
  } catch (error) {
    if (error instanceof SendRefused) {
      return {
        ok: false,
        error: "rate_limited",
        data: { retryAfterSeconds: error.retryAfterSeconds },
      };
    }
    // A database error holds the statement and its parameters (the number, the hash). Only fixed
    // text leaves, with no cause (R14); the transaction has rolled back, so nothing was sent. The
    // package's own fixed-text faults (a TypeError of a bad configuration or id, the store fault)
    // pass as they are.
    if (error instanceof TypeError || (error instanceof Error && error.message === NOT_STORED)) {
      throw error;
    }
    throw new Error(SEND_FAILED);
  }

  // 5. Outside any transaction.
  if (outcome.kind === "conflict") return { ok: false, error: "conflict" };
  if (outcome.kind === "replayed") {
    const stored = outcome.challenge;
    if (stored.consumedAt !== null || stored.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, error: "conflict" };
    }
    return {
      ok: true,
      value: {
        challengeId: stored.id,
        phoneMasked: maskPhone(stored.phone),
        expiresAt: stored.expiresAt,
        resendAt: new Date(
          stored.expiresAt.getTime() + (OTP.resendSeconds - OTP.ttlSeconds) * 1000,
        ),
        replayed: true,
      },
    };
  }

  // 6. The gateway, after the commit.
  const answer = await callGateway(deps.sms, phone, text, deps.sendTimeoutMs ?? OTP.sendTimeoutMs);
  if (answer === "ok") {
    return {
      ok: true,
      value: {
        challengeId: id,
        phoneMasked: maskPhone(phone),
        expiresAt,
        resendAt: new Date(now.getTime() + OTP.resendSeconds * 1000),
        replayed: false,
      },
    };
  }
  // The send stays counted (open point 8). If the closing throws, the error leaves (fail closed).
  try {
    await deps.run(async (tx) => {
      await customerRepos(tx, session.customerId).otp.close(id, deps.clock.now());
    });
  } catch {
    throw new Error(SEND_FAILED);
  }
  return answer === "rejected"
    ? { ok: false, error: "validation", fields: { phone: "rejected" } }
    : { ok: false, error: "upstream_unavailable" };
}
