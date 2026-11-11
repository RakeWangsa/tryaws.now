import type { CustomerSession } from "@tc/auth";
import { maskPhone } from "@tc/core";
import { customerRepos, withTx } from "@tc/db";
import { OTP } from "@tc/notify";

// What the phone step of /verify shows (open point 15), read through the tenant-scoped repositories
// with the customer id of the verified session (R8): the profile (is the phone verified, which
// number) and the newest challenge (is a code open, for which masked number, when may it be sent
// again). No other customer's row is reachable from here.

export type PhoneStep =
  | { kind: "verified" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      /** The number to prefill: the open challenge's number, else the profile's. Editable. */
      phone: string;
      /** A code was sent and is still good. */
      challenge: { phoneMasked: string; resendAt: number } | null;
      /** Made on the server for this render: one send for one key (R7). */
      idempotencyKey: string;
    };

export async function loadPhoneStep(
  session: Pick<CustomerSession, "customerId">,
  otpConfigured: boolean,
  now: Date = new Date(),
): Promise<PhoneStep> {
  const found = await withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    return { profile: await repos.profile.get(), challenge: await repos.otp.latest() };
  });
  // A session without a customer row cannot happen after requireCustomer; refuse if it does (R16).
  if (found.profile === null) return { kind: "unavailable" };
  if (found.profile.phoneVerifiedAt !== null) return { kind: "verified" };
  if (!otpConfigured) return { kind: "unavailable" };

  const open =
    found.challenge !== null &&
    found.challenge.consumedAt === null &&
    found.challenge.expiresAt.getTime() > now.getTime()
      ? found.challenge
      : null;
  return {
    kind: "ready",
    phone: open?.phone ?? found.profile.phone ?? "",
    challenge:
      open === null
        ? null
        : {
            phoneMasked: maskPhone(open.phone),
            resendAt: Math.floor(open.createdAt.getTime() / 1000) + OTP.resendSeconds,
          },
    idempotencyKey: crypto.randomUUID(),
  };
}
