import type { Locale } from "./types";

// The identity-provider port (WP2-T2, open point 1): sign-up, confirmation, sign-in and reset as the
// customer pool offers them. The apps depend on this interface; the Cognito adapter and an in-memory
// fake implement it. Types only: no behaviour, no environment, no secret.

export type IdpFailure =
  | "invalid_code"
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
  signIn(i: { email: string; password: string }): Promise<IdpResult<SignInOutcome>>;
  forgotPassword(email: string): Promise<IdpResult<true>>;
  confirmForgotPassword(i: {
    email: string;
    code: string;
    newPassword: string;
  }): Promise<IdpResult<true>>;
  revokeRefreshToken(refreshToken: string): Promise<IdpResult<true>>;
}
