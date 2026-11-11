import type { Clock, ErrorCode, Result } from "@tc/core";

export type { Clock, ErrorCode, Result };

export type KycStatus = "none" | "pending" | "verified" | "rejected";
export type RiskTier = "new" | "trusted";
export type Locale = "bn" | "en";

// Section F. Exactly these five fields; this package adds none.
export interface CustomerSession {
  readonly customerId: string;
  readonly kycStatus: KycStatus;
  readonly riskTier: RiskTier;
  readonly locale: Locale;
  readonly signedInAt: Date;
}

// Why a request has no session. Reported to onDenied; never shown to the customer (R14, 16.13).
export type AuthReason =
  | "no_cookie"
  | "token_invalid"
  | "token_expired"
  | "unknown_subject"
  | "revoked"
  | "suspended"
  | "unavailable"
  | "not_configured"
  | "fresh_sign_in_required";

export type AuthErrorCode = Extract<
  ErrorCode,
  "unauthenticated" | "forbidden" | "upstream_unavailable"
>;

export type Denied = {
  readonly ok: false;
  readonly error: AuthErrorCode;
  readonly reason: AuthReason;
};

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly reason: AuthReason;

  constructor(code: AuthErrorCode, reason: AuthReason) {
    // Fixed text: a message can reach a log, and must never carry a token (R14).
    super(`auth: ${code}`);
    this.name = "AuthError";
    this.code = code;
    this.reason = reason;
  }
}

export function toResult(error: unknown): { ok: false; error: ErrorCode } {
  if (error instanceof AuthError) return { ok: false, error: error.code };
  // Any foreign error: its message may hold a token or a row, so none is kept.
  return { ok: false, error: "internal" };
}
