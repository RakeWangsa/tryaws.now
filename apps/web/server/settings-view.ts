import type { CustomerSession } from "@tc/auth";
import { maskPhone } from "@tc/core";
import { customerRepos, withTx } from "@tc/db";
import type { BillingProfile, CustomerProfile } from "@tc/db";

// What /settings/profile shows. The phone number is masked on the screen; the full number is not
// sent to the browser (R14). `open` is false when the identity or SMS adapters are not configured:
// the change forms are then replaced by the "not open" state (R16).

/**
 * The billing details of the customer (WPU-I3), shown to the customer only, in their own form. The BIN
 * and the NID are personal or business identifiers: this screen goes to the customer's own browser and
 * nowhere else (R14: never logged).
 */
export interface BillingScreen {
  readonly billingName: string;
  readonly billingAddress: string;
  readonly customerBin: string;
  readonly customerNid: string;
}

export const EMPTY_BILLING: BillingScreen = Object.freeze({
  billingName: "",
  billingAddress: "",
  customerBin: "",
  customerNid: "",
});

export function toBillingScreen(billing: BillingProfile | null): BillingScreen {
  if (billing === null) return EMPTY_BILLING;
  return {
    billingName: billing.billingName ?? "",
    billingAddress: billing.billingAddress ?? "",
    customerBin: billing.customerBin ?? "",
    customerNid: billing.customerNid ?? "",
  };
}

export interface ProfileScreen {
  readonly name: string;
  readonly email: string;
  readonly phoneMasked: string | null;
  readonly phoneVerified: boolean;
  readonly locale: "bn" | "en";
  readonly open: boolean;
  readonly billing: BillingScreen;
}

export function toProfileScreen(
  profile: Pick<CustomerProfile, "name" | "email" | "phone" | "phoneVerifiedAt" | "locale">,
  open: boolean,
  billing: BillingProfile | null = null,
): ProfileScreen {
  return {
    name: profile.name ?? "",
    email: profile.email,
    phoneMasked: profile.phone === null ? null : maskPhone(profile.phone),
    phoneVerified: profile.phone !== null && profile.phoneVerifiedAt !== null,
    locale: profile.locale,
    open,
    billing: toBillingScreen(billing),
  };
}

export async function loadProfileScreen(
  session: CustomerSession,
  open: boolean,
): Promise<ProfileScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("settings: no customer row");
    return toProfileScreen(profile, open, await repos.profile.getBilling());
  });
}
