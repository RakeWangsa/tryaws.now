import { missingSetupSteps, type AccountSetupFacts, type AccountSetupStep } from "@tc/core";

// WPU-X11 (owner decision 2026-11-14): the buy screens show what the customer still has to do before they
// can buy: e-mail verified, mobile verified, authenticator on. The same predicate as the server-side gate
// of the draft and the purchase (packages/core/account/setup.ts, checkCustomer), so a screen never offers
// what the purchase refuses. KYC is no longer read.

export type AccountSetupRequired = {
  state: "account_setup_required";
  /** The steps not done, in the order the customer meets them. */
  missing: AccountSetupStep[];
};

/** null when the customer may buy; otherwise the screen state that lists the missing steps. */
export function accountSetupGate(profile: AccountSetupFacts): AccountSetupRequired | null {
  const missing = missingSetupSteps(profile);
  return missing.length === 0 ? null : { state: "account_setup_required", missing };
}

/** Where each step is done in the panel. */
export const SETUP_STEP_PATHS: Readonly<Record<AccountSetupStep, string>> = {
  email: "/settings/profile",
  phone: "/verify",
  totp: "/settings/security",
};
