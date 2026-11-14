import type { Locale } from "./types";

// The identity-provider port (WP2-T2, open point 1): sign-up, confirmation, sign-in and reset as the
// customer pool offers them. The apps depend on this interface; the Cognito adapter and an in-memory
// fake implement it. Types only: no behaviour, no environment, no secret.

export type IdpFailure =
  | "invalid_code"
  // WPU-X11 round 2: the password was right and the authenticator code was not (wrong, reused or expired).
  // Only the sign-in with a code returns it. The screen answers it exactly like `denied`; the app counts
  // it against its own limit on wrong codes.
  | "code_denied"
  | "expired_code"
  | "invalid_password"
  | "denied"
  | "not_confirmed"
  | "rate_limited"
  | "unavailable";

export type IdpResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: IdpFailure };

export type SignUpOutcome =
  { readonly kind: "created"; readonly sub: string } | { readonly kind: "exists" };

export type SignInOutcome =
  | {
      readonly kind: "tokens";
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly expiresInSeconds: number;
      /**
       * WPU-X11 round 2: true only when these tokens answer the SOFTWARE_TOKEN_MFA challenge of this very
       * flow. Absent otherwise: the account has no authenticator at Cognito, or it was switched off outside
       * this app, which the sign-in then reconciles (auth.totp_drift).
       */
      readonly totpVerified?: true;
    }
  // No Session string leaves the adapter (open point 16).
  | { readonly kind: "challenge"; readonly challenge: "totp" | "other" };

export interface IdentityProvider {
  signUp(i: {
    email: string;
    password: string;
    name: string;
    locale: Locale;
  }): Promise<IdpResult<SignUpOutcome>>;
  confirmSignUp(i: { email: string; code: string }): Promise<IdpResult<true>>;
  resendConfirmationCode(email: string): Promise<IdpResult<true>>;
  /**
   * WPU-X11: `totpCode` answers the SOFTWARE_TOKEN_MFA challenge of the same flow inside the adapter, so
   * the Cognito Session never leaves it (open point 16). Without a code, the challenge is reported.
   */
  signIn(i: {
    email: string;
    password: string;
    totpCode?: string;
  }): Promise<IdpResult<SignInOutcome>>;
  forgotPassword(email: string): Promise<IdpResult<true>>;
  confirmForgotPassword(i: {
    email: string;
    code: string;
    newPassword: string;
  }): Promise<IdpResult<true>>;
  revokeRefreshToken(refreshToken: string): Promise<IdpResult<true>>;
}
