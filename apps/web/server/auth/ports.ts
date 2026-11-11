import type { AccountRegistered, CustomerSession, SignedIn } from "@tc/auth";
import type { Result } from "@tc/core";
import type { OtpSent, OtpVerified } from "@tc/notify";
import type { AuthAction, Who } from "./limits.ts";

// The side effects of the action cores that touch the database or the session, behind one interface,
// so the cores run in tests with fakes (no database) and the order of the steps can be recorded.
// The production implementation is server/auth-ports.ts.

export type LimitAnswer = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RequestMeta {
  /** The viewer address (CloudFront-Viewer-Address), already checked. */
  ip: string;
  userAgent?: string;
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
