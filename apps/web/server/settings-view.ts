import type { CustomerSession } from "@tc/auth";
import { maskPhone } from "@tc/core";
import { customerRepos, withTx } from "@tc/db";
import type { CustomerProfile } from "@tc/db";

// What /settings/profile shows. The phone number is masked on the screen; the full number is not
// sent to the browser (R14). `open` is false when the identity or SMS adapters are not configured:
// the change forms are then replaced by the "not open" state (R16).

export interface ProfileScreen {
  readonly name: string;
  readonly email: string;
  readonly phoneMasked: string | null;
  readonly phoneVerified: boolean;
  readonly locale: "bn" | "en";
  readonly open: boolean;
}

export function toProfileScreen(
  profile: Pick<CustomerProfile, "name" | "email" | "phone" | "phoneVerifiedAt" | "locale">,
  open: boolean,
): ProfileScreen {
  return {
    name: profile.name ?? "",
    email: profile.email,
    phoneMasked: profile.phone === null ? null : maskPhone(profile.phone),
    phoneVerified: profile.phone !== null && profile.phoneVerifiedAt !== null,
    locale: profile.locale,
    open,
  };
}

export async function loadProfileScreen(
  session: CustomerSession,
  open: boolean,
): Promise<ProfileScreen> {
  return withTx(async (tx) => {
    const profile = await customerRepos(tx, session.customerId).profile.get();
    if (profile === null) throw new Error("settings: no customer row");
    return toProfileScreen(profile, open);
  });
}
