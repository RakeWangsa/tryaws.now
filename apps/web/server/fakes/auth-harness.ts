import { sessionCookieSpecs } from "@tc/auth";
import type { AccountRegistered, CustomerSession, IdentityProvider, SignedIn } from "@tc/auth";
import type { Result } from "@tc/core";
import { limitKey } from "@tc/db";
import type { LimitDecision, LimitRule } from "@tc/db";
import { InMemorySmsProvider } from "@tc/notify";
import type { OtpSent, OtpVerified } from "@tc/notify";
import {
  enforceAuthLimit,
  peekAuthLimit,
  releaseAuthLimit,
  reserveAuthLimit,
} from "../auth/limits.ts";
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
  /** WPU-X11 round 2: what the audit step of each sign-in was told about the authenticator. */
  signIns: { customerId: string; totpVerified: boolean }[];
  /** WPU-X11 round 2: the "wrong authenticator codes" notices that were queued. */
  notices: { email: string; ip: string; key: string }[];
  /** The counters of the in-memory limiter, by key and window. */
  counts: Map<string, number>;
  registered: unknown[];
  rules: LimitRule[][];
  state: {
    session: CustomerSession | null;
    marketOpen: boolean;
    registerFails: boolean;
    auditFails: boolean;
    noticeFails: boolean;
    idpDown: boolean;
    otpOn: boolean;
  };
  runtime: WebRuntime;
  ports: AuthPorts;
  ctx(headers?: Headers): ActionContext;
  /** Moves the clock of the harness forward. */
  advance(ms: number): void;
  /** The time of the harness now. */
  now(): Date;
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
  // A clock a test can move (the windows of the limiters roll with it).
  let nowMs = NOW.getTime();
  const clock = { now: () => new Date(nowMs) };
  const events: string[] = [];
  const customers = new Map<string, Customer>();
  const audits: Harness["audits"] = [];
  const signIns: Harness["signIns"] = [];
  const notices: Harness["notices"] = [];
  const noticedKeys = new Set<string>();
  const registered: unknown[] = [];
  const rules: LimitRule[][] = [];
  const counts = new Map<string, number>();
  const state: Harness["state"] = {
    session: null,
    marketOpen: true,
    registerFails: false,
    auditFails: false,
    noticeFails: false,
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

  // All or nothing, like consume inside a transaction that rolls back on a refusal.
  const consumeAll = async (
    _tx: unknown,
    given: readonly LimitRule[],
    now: Date,
  ): Promise<LimitDecision> => {
    const prepared = given.map((rule) => ({
      rule,
      key: `${limitKey(rule.kind, rule.subject, rule.action, rule.windowSeconds)}@${Math.floor(
        now.getTime() / (rule.windowSeconds * 1000),
      )}`,
    }));
    for (const { rule, key } of prepared) {
      if ((counts.get(key) ?? 0) >= rule.limit) {
        return { allowed: false, action: rule.action, retryAfterSeconds: 123 };
      }
    }
    for (const { key } of prepared) counts.set(key, (counts.get(key) ?? 0) + 1);
    return { allowed: true };
  };

  // Like peekRateLimits: a refusal when a rule is already at its limit, and nothing counted.
  const peek = async (
    _tx: unknown,
    given: readonly LimitRule[],
    now: Date,
  ): Promise<LimitDecision> => {
    for (const rule of given) {
      const key = `${limitKey(rule.kind, rule.subject, rule.action, rule.windowSeconds)}@${Math.floor(
        now.getTime() / (rule.windowSeconds * 1000),
      )}`;
      if ((counts.get(key) ?? 0) >= rule.limit) {
        return { allowed: false, action: rule.action, retryAfterSeconds: 123 };
      }
    }
    return { allowed: true };
  };

  // Like releaseRateLimits: one hit back for each rule in the window of `at`, never below zero.
  const release = async (_tx: unknown, given: readonly LimitRule[], at: Date): Promise<void> => {
    for (const rule of given) {
      const key = `${limitKey(rule.kind, rule.subject, rule.action, rule.windowSeconds)}@${Math.floor(
        at.getTime() / (rule.windowSeconds * 1000),
      )}`;
      const seen = counts.get(key) ?? 0;
      if (seen > 0) counts.set(key, seen - 1);
    }
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
    async limitReserve(action, who, key) {
      events.push("limitReserve");
      // The in-memory counters have no rollback: this one checks every rule first and counts only when all
      // of them have room, which is what the rolled-back transaction gives the real one.
      return reserveAuthLimit(
        (fn) => fn({} as never),
        key,
        clock,
        action,
        who,
        consumeAll as never,
      );
    },
    async limitPeek(action, who, key) {
      events.push("limitPeek");
      return peekAuthLimit((fn) => fn({} as never), key, clock, action, who, peek as never);
    },
    async limitRelease(action, who, key, at) {
      events.push("limitRelease");
      return releaseAuthLimit((fn) => fn({} as never), key, at, action, who, release as never);
    },
    async noticeTotpBlocked(input) {
      events.push("notice");
      if (state.noticeFails) throw new Error("queue down");
      // The queue drops a second row with the same dedupe key (one per address and quarter hour).
      const dedupe = `${input.email}:${Math.floor(clock.now().getTime() / 900_000)}`;
      if (noticedKeys.has(dedupe)) return;
      noticedKeys.add(dedupe);
      notices.push({ email: input.email, ip: input.ip, key: input.key });
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
      signIns.push({ customerId: session.customerId, totpVerified: meta.totpVerified === true });
      const customer = [...customers.values()].find((c) => c.customerId === session.customerId);
      return { phoneVerified: customer?.phoneVerified ?? false };
    },
    async recordSignOut(session, meta) {
      events.push("audit");
      audits.push({ customerId: session.customerId, action: "auth.sign_out", ip: meta.ip });
    },
    async recordReauthRefused(session, meta) {
      events.push("audit");
      audits.push({ customerId: session.customerId, action: "auth.reauth_refused", ip: meta.ip });
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
    signIns,
    notices,
    counts,
    registered,
    rules,
    state,
    runtime,
    ports,
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => new Date(nowMs),
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
