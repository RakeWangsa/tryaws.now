import type { AccountRegistered, CustomerSession, SignedIn } from "@tc/auth";
import type { Result } from "@tc/core";
import type { OtpSent, OtpVerified } from "@tc/notify";
import type { AuthAction, Who } from "./limits.ts";

// The side effects of the action cores that touch the database or the session, behind one interface,
// so the cores run in tests with fakes (no database) and the order of the steps can be recorded.
// The production implementation is server/auth-ports.ts.

export type LimitAnswer = { allowed: true } | { allowed: false; retryAfterSeconds: number };
/** A reservation also says the time its count used, for the matching release (WPU-X11). */
export type ReserveAnswer =
  { allowed: true; at: Date } | { allowed: false; retryAfterSeconds: number };

export interface RequestMeta {
  /** The viewer address (CloudFront-Viewer-Address), already checked. */
  ip: string;
  userAgent?: string;
  /**
   * WPU-X11 round 2: the tokens of this sign-in answered the authenticator challenge. Absent when the
   * provider gave tokens without one, which for a customer whose platform copy says "on" means the
   * authenticator was switched off outside the panel (recordSignIn then clears the copy).
   */
  totpVerified?: true;
}

export interface AuthPorts {
  /** The verified session of this request, or null. Never throws. */
  currentSession(): Promise<CustomerSession | null>;
  /** Like requireCustomer(): the session, or why there is none. Never throws. */
  requireSession(): Promise<
    | { ok: true; session: CustomerSession }
    | { ok: false; reason: "unauthenticated" | "unavailable" }
  >;
  limit(action: AuthAction, who: Who, key: string): Promise<LimitAnswer>;
  /**
   * WPU-X11 round 2: like `limit` but all or nothing: a refused reservation counts nothing (the transaction
   * rolls back), so being blocked and retrying never uses up the longer window.
   */
  limitReserve(action: AuthAction, who: Who, key: string): Promise<ReserveAnswer>;
  /** WPU-X11 round 2: the same rules as `limit`, read and never counted. */
  limitPeek(action: AuthAction, who: Who, key: string): Promise<LimitAnswer>;
  /**
   * WPU-X11 round 2: gives back one hit that `limit` counted for the same rules, in the window of `at`.
   * The sign-in reserves the attempt with `limit` before the provider is asked and releases it unless the
   * attempt was a wrong code. False when it could not: the hit then stays counted.
   */
  limitRelease(action: "signin_code", who: Who, key: string, at: Date): Promise<boolean>;
  /**
   * WPU-X11 round 2: queues the email "a correct password, too many wrong authenticator codes" for the
   * address that typed the password (the sign-in knows the address, not the customer). Never throws: the
   * answer to the customer does not depend on it. `key` is the limiter key, for the one-per-window dedupe.
   */
  noticeTotpBlocked(input: { email: string; ip: string; key: string }): Promise<void>;
  register(input: {
    email: string;
    phone: string;
    name: string;
    locale: "bn" | "en";
    password: string;
    acceptances: readonly {
      document: "terms" | "acceptable_use" | "privacy";
      version: string;
    }[];
    ip: string;
    userAgent?: string;
  }): Promise<AccountRegistered>;
  completeSignIn(tokens: {
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: number;
  }): Promise<SignedIn>;
  /** Audit row `auth.sign_in` and the phone state of the profile. Throws when it cannot (fail closed). */
  recordSignIn(session: CustomerSession, meta: RequestMeta): Promise<{ phoneVerified: boolean }>;
  recordSignOut(session: CustomerSession, meta: Partial<RequestMeta>): Promise<void>;
  sendOtp(
    session: CustomerSession,
    input: { phone: string; ip: string; idempotencyKey: string },
  ): Promise<Result<OtpSent>>;
  verifyOtp(session: CustomerSession, input: { code: string }): Promise<Result<OtpVerified>>;
}
