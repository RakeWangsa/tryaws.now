import { consumeRateLimits, peekRateLimits, releaseRateLimits } from "@tc/db";
import type { LimitDecision, LimitRule, Tx } from "@tc/db";
import { emailSubject, ipSubject } from "@tc/notify";
import type { Clock } from "@tc/core";

// The limits of the public auth actions (open point 8). One table in one file; the owner can change
// the numbers. Subjects are keyed hashes (secret AuthLimitKey), so the key table holds neither an
// address nor an email (R14). The client address is the CloudFront-Viewer-Address only (context.ts).

export type AuthAction =
  "signup" | "confirm" | "resend" | "signin" | "signin_code" | "forgot" | "reset";

export interface AuthLimit {
  readonly kind: "ip" | "email";
  /** address = the client network; email = the address typed; pair = both together. */
  readonly scope: "address" | "email" | "pair";
  readonly action: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

const HOUR = 3600;

export const AUTH_LIMITS: Readonly<Record<AuthAction, readonly AuthLimit[]>> = Object.freeze({
  signup: [
    { kind: "ip", scope: "address", action: "auth.signup", limit: 5, windowSeconds: HOUR },
    { kind: "email", scope: "email", action: "auth.signup", limit: 3, windowSeconds: HOUR },
  ],
  confirm: [
    { kind: "ip", scope: "address", action: "auth.confirm", limit: 20, windowSeconds: HOUR },
    { kind: "email", scope: "email", action: "auth.confirm", limit: 8, windowSeconds: HOUR },
  ],
  resend: [
    { kind: "email", scope: "email", action: "auth.resend", limit: 1, windowSeconds: 60 },
    { kind: "email", scope: "email", action: "auth.resend", limit: 3, windowSeconds: HOUR },
    { kind: "ip", scope: "address", action: "auth.resend", limit: 10, windowSeconds: HOUR },
  ],
  signin: [
    { kind: "email", scope: "pair", action: "auth.signin", limit: 8, windowSeconds: 900 },
    { kind: "ip", scope: "address", action: "auth.signin", limit: 30, windowSeconds: 900 },
    { kind: "email", scope: "email", action: "auth.signin", limit: 40, windowSeconds: HOUR },
  ],
  // WPU-X11 round 2: authenticator codes that failed AFTER a correct password. Counted per address typed
  // (not per network: the account is what is guarded, and an attacker who has the password changes
  // address), only on a failure; asked first with peekAuthLimit. 5 in 15 minutes and 20 a day, then the
  // sign-in with a code is refused and the customer gets an email. Cognito has its own lockout on top.
  signin_code: [
    { kind: "email", scope: "email", action: "auth.signin_code", limit: 5, windowSeconds: 900 },
    { kind: "email", scope: "email", action: "auth.signin_code", limit: 20, windowSeconds: 86_400 },
  ],
  forgot: [
    { kind: "email", scope: "email", action: "auth.forgot", limit: 3, windowSeconds: HOUR },
    { kind: "ip", scope: "address", action: "auth.forgot", limit: 10, windowSeconds: HOUR },
  ],
  reset: [
    { kind: "email", scope: "email", action: "auth.reset", limit: 8, windowSeconds: HOUR },
    { kind: "ip", scope: "address", action: "auth.reset", limit: 20, windowSeconds: HOUR },
  ],
});

export type Who = { readonly ip: string; readonly email: string };
type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
type Consume = (tx: Tx, rules: readonly LimitRule[], now: Date) => Promise<LimitDecision>;
type Peek = Consume;

/** The rules of one action for one caller, or null when a subject cannot be made (fail closed). */
export function buildRules(key: string, action: AuthAction, who: Who): LimitRule[] | null {
  const ip = ipSubject(key, who.ip);
  if (ip === null) return null;
  const rules: LimitRule[] = [];
  for (const row of AUTH_LIMITS[action]) {
    let subject: string | null;
    if (row.scope === "address") subject = ip;
    else if (row.scope === "email") subject = emailSubject(key, who.email);
    else subject = emailSubject(key, who.email, who.ip);
    if (subject === null) return null;
    rules.push({
      kind: row.kind,
      subject,
      action: row.action,
      limit: row.limit,
      windowSeconds: row.windowSeconds,
    });
  }
  return rules;
}

/**
 * Counts one attempt against every rule of the action, in one transaction that always commits (it
 * never throws on a refusal, so the counters of the rules before the refusing one stay counted).
 * Any error, or a subject that cannot be made, is a refusal (R16).
 */
export async function enforceAuthLimit(
  run: Run,
  key: string,
  clock: Clock,
  action: AuthAction,
  who: Who,
  consume: Consume = consumeRateLimits,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  try {
    const rules = buildRules(key, action, who);
    if (rules === null) return { allowed: false, retryAfterSeconds: 60 };
    const now = clock.now();
    const decision = await run((tx) => consume(tx, rules, now));
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds };
  } catch {
    return { allowed: false, retryAfterSeconds: 60 };
  }
}

/**
 * WPU-X11 round 2. The same rules as enforceAuthLimit, read and never counted: "is this caller already at the
 * limit". The sign-in asks it before it sends an authenticator code to the provider, and counts a failure
 * afterwards with enforceAuthLimit. Any error, or a subject that cannot be made, is a refusal (R16).
 */
export async function peekAuthLimit(
  run: Run,
  key: string,
  clock: Clock,
  action: AuthAction,
  who: Who,
  peek: Peek = peekRateLimits,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  try {
    const rules = buildRules(key, action, who);
    if (rules === null) return { allowed: false, retryAfterSeconds: 60 };
    const decision = await run((tx) => peek(tx, rules, clock.now()));
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds };
  } catch {
    return { allowed: false, retryAfterSeconds: 60 };
  }
}

/**
 * WPU-X11 round 2. Gives back one hit that enforceAuthLimit counted for the same rules, in the window of
 * `at` (the time of the reservation). The sign-in reserves its attempt BEFORE it calls the provider, so that
 * parallel guesses cannot all pass a check first, and releases it unless the attempt was a wrong code.
 * Returns false when it could not (the hit then stays counted: the safe direction, R16).
 */
export async function releaseAuthLimit(
  run: Run,
  key: string,
  at: Date,
  action: AuthAction,
  who: Who,
  release: (tx: Tx, rules: readonly LimitRule[], now: Date) => Promise<void> = releaseRateLimits,
): Promise<boolean> {
  try {
    const rules = buildRules(key, action, who);
    if (rules === null) return false;
    await run((tx) => release(tx, rules, at));
    return true;
  } catch {
    return false;
  }
}
