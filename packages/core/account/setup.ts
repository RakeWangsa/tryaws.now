// WPU-X11. Owner decision 2026-11-14 (chat, verbatim): "KYC IS not need for customer, only email and
// mobile verification then 2fa authenticator. make it more simpler..as out system is wallet based".
//
// A customer may buy (draft, purchase) when three facts are stored on the customers row, each set by the
// server only after the step was proven:
//   email  customers.email_verified_at  set at the first sign-in (Cognito signs in confirmed addresses only)
//   phone  customers.phone_verified_at  set by the OTP service after the SMS code matched (WP2-T3)
//   totp   customers.totp_enabled_at    set after Cognito VerifySoftwareToken and SetUserMFAPreference succeeded
// Pure logic. R16: a value that is not a valid Date proves nothing, and the step counts as missing.

export const ACCOUNT_SETUP_STEPS = ["email", "phone", "totp"] as const;
export type AccountSetupStep = (typeof ACCOUNT_SETUP_STEPS)[number];

export interface AccountSetupFacts {
  readonly emailVerifiedAt: Date | null;
  readonly phoneVerifiedAt: Date | null;
  readonly totpEnabledAt: Date | null;
}

const proven = (value: unknown): boolean => value instanceof Date && !Number.isNaN(value.getTime());

/** The steps that are not done, in the order the customer meets them. A missing profile misses all. */
export function missingSetupSteps(facts: AccountSetupFacts | null | undefined): AccountSetupStep[] {
  if (typeof facts !== "object" || facts === null) return [...ACCOUNT_SETUP_STEPS];
  const done: Record<AccountSetupStep, boolean> = {
    email: proven(facts.emailVerifiedAt),
    phone: proven(facts.phoneVerifiedAt),
    totp: proven(facts.totpEnabledAt),
  };
  return ACCOUNT_SETUP_STEPS.filter((step) => !done[step]);
}

/** E-mail verified AND mobile verified AND authenticator on. The one predicate of every buy gate. */
export function canBuy(facts: AccountSetupFacts | null | undefined): boolean {
  return missingSetupSteps(facts).length === 0;
}
