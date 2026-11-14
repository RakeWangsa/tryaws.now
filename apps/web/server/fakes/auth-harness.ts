import { sessionCookieSpecs } from "@tc/auth";
import type { AccountRegistered, CustomerSession, IdentityProvider, SignedIn } from "@tc/auth";
import type { Result } from "@tc/core";
import { limitKey } from "@tc/db";
import type { LimitDecision, LimitRule } from "@tc/db";
import { InMemorySmsProvider } from "@tc/notify";
import type { OtpSent, OtpVerified } from "@tc/notify";
import { enforceAuthLimit } from "../auth/limits.ts";
import { actionContext } from "../auth/context.ts";
import type { ActionContext } from "../auth/context.ts";
import type { AuthPorts } from "../auth/ports.ts";
import type { WebRuntime } from "../runtime.ts";
import { InMemoryIdentityProvider } from "./identity.ts";
import { resetFakeState } from "./outbox.ts";

// A harness for the unit tests of the action cores: the real in-memory identity provider, a limiter
// that counts like rate_limits does (in memory), and fake ports that record every call in order. No
// database, no network. Used by tests only; it lives in this folder because it names the fakes.

export const ORIGIN = "http://localhost:3000";
export const LIMIT_KEY = "k".repeat(40);
export const NOW = new Date("2026-11-12T10:00:00.000Z");

export const SIGN_UP_FORM = {
  fullName: "Rahim Uddin",
  email: "rahim@example.test",
  phone: "01712345678",
  password: "correct horse 99",
  passwordConfirm: "correct horse 99",
  consentTerms: "on",
  consentAup: "on",
  consentPrivacy: "on",
  locale: "bn",
} as const;

export const goodHeaders = (over: Record<string, string> = {}): Headers =>
  new Headers({
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "cloudfront-viewer-address": "198.51.100.7:4711",
    "user-agent": "vitest-agent",
    ...over,
  });

export interface Customer {
  customerId: string;
  sub: string;
  suspended: boolean;
  revoked: boolean;
  phoneVerified: boolean;
  locale: "bn" | "en";
}

export interface Harness {
  events: string[];
  idp: IdentityProvider;
  sms: InMemorySmsProvider;
  customers: Map<string, Customer>;
  audits: { customerId: string; action: string; ip: string | undefined }[];
  registered: unknown[];
  rules: LimitRule[][];
  state: {
    session: CustomerSession | null;
    marketOpen: boolean;
    registerFails: boolean;
    auditFails: boolean;
    idpDown: boolean;
    otpOn: boolean;
  };
  runtime: WebRuntime;
  ports: AuthPorts;
  ctx(headers?: Headers): ActionContext;
  signedUp(email?: string): Promise<Customer>;
}

const UUID = (n: number): string => `0191a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** Wraps a provider so that every call is recorded and, on demand, answers "unavailable". */
function recorded(
  inner: InMemoryIdentityProvider,
  events: string[],
  down: () => boolean,
): IdentityProvider {
  const wrap = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      events.push(`idp.${name}`);
      if (down()) return { ok: false, kind: "unavailable" } as unknown as R;
      return fn.apply(inner, args);
    };
  };
  return {
    signUp: wrap("signUp", inner.signUp),
    confirmSignUp: wrap("confirmSignUp", inner.confirmSignUp),
    resendConfirmationCode: wrap("resendConfirmationCode", inner.resendConfirmationCode),
    signIn: wrap("signIn", inner.signIn),
    forgotPassword: wrap("forgotPassword", inner.forgotPassword),
    confirmForgotPassword: wrap("confirmForgotPassword", inner.confirmForgotPassword),
    revokeRefreshToken: wrap("revokeRefreshToken", inner.revokeRefreshToken),
  };
}

export function makeHarness(): Harness {
  resetFakeState();
  const clock = { now: () => NOW };
  const events: string[] = [];
  const customers = new Map<string, Customer>();
  const audits: Harness["audits"] = [];
  const registered: unknown[] = [];
  const rules: LimitRule[][] = [];
  const counts = new Map<string, number>();
  const state: Harness["state"] = {
    session: null,
    marketOpen: true,
    registerFails: false,
    auditFails: false,
    idpDown: false,
    otpOn: true,
  };
  const sms = new InMemorySmsProvider();
  const idp = recorded(
    new InMemoryIdentityProvider({ stage: "test", fakes: true, clock }),
    events,
    () => state.idpDown,
  );

  // Counts like consumeRateLimits: ascending key order, stop at the first refusal, the count never
  // passes the limit.
  const consume = async (
    _tx: unknown,
    given: readonly LimitRule[],
    now: Date,
  ): Promise<LimitDecision> => {
    rules.push([...given]);
    const prepared = given
      .map((rule) => ({
        rule,
        key: `${limitKey(rule.kind, rule.subject, rule.action, rule.windowSeconds)}@${Math.floor(
          now.getTime() / (rule.windowSeconds * 1000),
        )}`,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const { rule, key } of prepared) {
      const seen = counts.get(key) ?? 0;
      if (seen >= rule.limit) {
        return { allowed: false, action: rule.action, retryAfterSeconds: 123 };
      }
      counts.set(key, seen + 1);
    }
    return { allowed: true };
  };

  const otpChallenges = new Map<string, { code: string; attempts: number; key: string }>();
  let nextCustomer = 1;
  let sendsDone = 0;

  const ports: AuthPorts = {
    async currentSession() {
      events.push("session");
      return state.session;
    },
    async requireSession() {
      events.push("session");
      return state.session === null
        ? { ok: false, reason: "unauthenticated" }
        : { ok: true, session: state.session };
    },
    async limit(action, who, key) {
      events.push("limit");
      return enforceAuthLimit((fn) => fn({} as never), key, clock, action, who, consume as never);
    },
    async register(input): Promise<AccountRegistered> {
      events.push("register");
      registered.push(input);
      if (!state.marketOpen) return { ok: false, error: "market_unavailable" };
      const signUp = await idp.signUp({
        email: input.email,
        password: input.password,
        name: input.name,
        locale: input.locale,
      });
      if (!signUp.ok) {
        if (signUp.kind === "invalid_password") return { ok: false, error: "validation" };
        if (signUp.kind === "rate_limited") return { ok: false, error: "rate_limited" };
        return { ok: false, error: "upstream_unavailable" };
      }
      if (signUp.value.kind === "exists") return { ok: true, status: "exists" };
      if (state.registerFails) return { ok: false, error: "internal" };
      const id = UUID(nextCustomer++);
      customers.set(signUp.value.sub, {
        customerId: id,
        sub: signUp.value.sub,
        suspended: false,
        revoked: false,
        phoneVerified: false,
        locale: input.locale,
      });
      return { ok: true, status: "created" };
    },
    async completeSignIn(tokens): Promise<SignedIn> {
      events.push("completeSignIn");
      const sub = tokens.accessToken.replace(/^dev\./, "");
      const customer = customers.get(sub);
      if (customer === undefined)
        return { ok: false, error: "unauthenticated", reason: "unknown_subject" };
      if (customer.revoked) return { ok: false, error: "unauthenticated", reason: "revoked" };
      if (customer.suspended) return { ok: false, error: "forbidden", reason: "suspended" };
      return {
        ok: true,
        session: {
          customerId: customer.customerId,
          kycStatus: "none",
          riskTier: "new",
          locale: customer.locale,
          signedInAt: NOW,
        },
        cookies: sessionCookieSpecs(
          {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessExpiresAt: new Date(NOW.getTime() + tokens.expiresInSeconds * 1000),
          },
          clock,
        ),
      };
    },
    async recordSignIn(session, meta) {
      events.push("audit");
      if (state.auditFails) throw new Error("audit failed");
      audits.push({ customerId: session.customerId, action: "auth.sign_in", ip: meta.ip });
      const customer = [...customers.values()].find((c) => c.customerId === session.customerId);
      return { phoneVerified: customer?.phoneVerified ?? false };
    },
    async recordSignOut(session, meta) {
      events.push("audit");
      audits.push({ customerId: session.customerId, action: "auth.sign_out", ip: meta.ip });
    },
    async sendOtp(session, input): Promise<Result<OtpSent>> {
      events.push("otp.send");
      const existing = otpChallenges.get(session.customerId);
      if (existing !== undefined && existing.key === input.idempotencyKey) {
        return {
          ok: true,
          value: {
            challengeId: "c",
            phoneMasked: "+880*******678",
            expiresAt: NOW,
            resendAt: NOW,
            replayed: true,
          },
        };
      }
      const sent = sendsDone;
      if (sent >= 3) return { ok: false, error: "rate_limited", data: { retryAfterSeconds: 77 } };
      const code = String(111111 + sent);
      sendsDone += 1;
      otpChallenges.set(session.customerId, { code, attempts: 0, key: input.idempotencyKey });
      await sms.send(input.phone, `code ${code}`);
      return {
        ok: true,
        value: {
          challengeId: "c",
          phoneMasked: "+880*******678",
          expiresAt: NOW,
          resendAt: NOW,
          replayed: false,
        },
      };
    },
    async verifyOtp(session, input): Promise<Result<OtpVerified>> {
      events.push("otp.verify");
      // Only the challenge of the session's customer is ever looked at (R8).
      const challenge = otpChallenges.get(session.customerId);
      if (challenge === undefined) return { ok: false, error: "not_found" };
      challenge.attempts += 1;
      if (challenge.attempts > 5) return { ok: false, error: "limit_reached" };
      if (challenge.code !== input.code) {
        return { ok: false, error: "validation", fields: { code: "wrong" } };
      }
      const customer = [...customers.values()].find((c) => c.customerId === session.customerId);
      if (customer !== undefined) customer.phoneVerified = true;
      return { ok: true, value: { phoneMasked: "+880*******678", verifiedAt: NOW } };
    },
  };

  const runtime: WebRuntime = {
    config: {
      stage: "staging",
      appOrigin: ORIGIN,
      epsMode: "sandbox",
      fakes: false,
      fake: { eps: false, idp: false, sms: false },
    },
    eps: null,
    identity: idp,
    otp: null,
    authLimitKey: LIMIT_KEY,
    kyc: null,
    kycCheck: null,
    account: null,
    totp: null,
    reader: null,
    access: null,
    renderer: null,
  };

  const otpDeps = {
    run: (fn: (tx: never) => Promise<unknown>) => fn({} as never),
    clock,
    pepper: "p".repeat(40),
    sms,
    limits: [],
  } as unknown as NonNullable<WebRuntime["otp"]>;
  runtime.otp = otpDeps;

  const harness: Harness = {
    events,
    idp,
    sms,
    customers,
    audits,
    registered,
    rules,
    state,
    runtime,
    ports,
    ctx: (headers = goodHeaders()) => {
      runtime.otp = state.otpOn ? otpDeps : null;
      return actionContext(headers, runtime, clock, ports);
    },
    async signedUp(email = SIGN_UP_FORM.email) {
      const created = await idp.signUp({
        email,
        password: SIGN_UP_FORM.password,
        name: "Rahim",
        locale: "bn",
      });
      if (!created.ok || created.value.kind !== "created") throw new Error("sign-up failed");
      const customer: Customer = {
        customerId: UUID(nextCustomer++),
        sub: created.value.sub,
        suspended: false,
        revoked: false,
        phoneVerified: false,
        locale: "bn",
      };
      customers.set(customer.sub, customer);
      const { getFakeState } = await import("./outbox.ts");
      const code = getFakeState().emailCodes.get(email)?.code ?? "";
      await idp.confirmSignUp({ email, code });
      events.length = 0;
      return customer;
    },
  };
  return harness;
}

export function sessionOf(customer: Customer): CustomerSession {
  return {
    customerId: customer.customerId,
    kycStatus: "none",
    riskTier: "new",
    locale: customer.locale,
    signedInAt: NOW,
  };
}
