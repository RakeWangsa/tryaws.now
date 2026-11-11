// The state of the sign-in form (useActionState). Only a fixed code, never text of an error (R14).
export type SignInError = "invalid" | "denied" | "unavailable" | "rate_limited";
export type SignInState = { readonly error: SignInError | null };
export const INITIAL_SIGN_IN: SignInState = { error: null };
