import type { CustomerSession } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import type { KycSubmissionView } from "@tc/db";

// What /kyc shows (16.9): one of four states. The note of a rejection is the reviewer's text for the
// customer; the S3 keys and the document number are not readable by this role and are not here.

export type KycScreen =
  | { state: "unavailable" }
  | { state: "verified" }
  | { state: "pending"; submission: KycSubmissionView }
  | {
      state: "rejected";
      submission: KycSubmissionView;
      customerType: "individual" | "business" | null;
      /** The upload port is there, so the customer may submit again. */
      canResubmit: boolean;
    }
  | { state: "form"; customerType: "individual" | "business" | null };

/** Pure: the status of the customer and the newest submission decide the state. Fail closed (R16). */
export function decideKycScreen(input: {
  kycStatus: string;
  customerType: "individual" | "business" | null;
  latest: KycSubmissionView | null;
  configured: boolean;
}): KycScreen {
  if (input.kycStatus === "verified") return { state: "verified" };
  const { latest } = input;
  if (latest !== null && latest.status === "pending")
    return { state: "pending", submission: latest };
  if (latest !== null && latest.status === "rejected") {
    return {
      state: "rejected",
      submission: latest,
      customerType: input.customerType,
      canResubmit: input.configured,
    };
  }
  // A new submission needs the upload port; without it the form is not offered.
  if (!input.configured) return { state: "unavailable" };
  return { state: "form", customerType: input.customerType };
}

export async function loadKyc(session: CustomerSession, configured: boolean): Promise<KycScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const [profile, latest] = await Promise.all([repos.profile.get(), repos.kyc.latest()]);
    if (profile === null) throw new Error("kyc: no customer row");
    return decideKycScreen({
      kycStatus: profile.kycStatus,
      customerType: profile.type,
      latest,
      configured,
    });
  });
}
