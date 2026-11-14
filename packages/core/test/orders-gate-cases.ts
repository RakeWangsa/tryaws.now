// The table of the third proof of WP4-T4: an order from a customer who may not buy creates no resource.
// Task 6 runs it through runPurchase, Task 7 again through placeOrder. WPU-X11 (owner decision 2026-11-14):
// "may buy" is now e-mail verified + mobile verified + authenticator on; KYC is not read. The refusal keeps
// the contract code `kyc_required` (Section F).
import type { OrderSession } from "../orders/types";
import { signDraft, verifyDraft } from "../orders/token";
import type { Kit } from "./orders-kit";

export interface GateCase {
  readonly name: string;
  /** `throws`: no customers row exists, the wallet lock fails and nothing is written (R16). */
  readonly expected: "kyc_required" | "forbidden" | "throws";
  /** Makes a draft for a customer who may buy, then bends the database to the state under test. */
  prepare(kit: Kit): Promise<{ session: OrderSession; token: string; customerId: string }>;
}

const bent = (
  name: string,
  expected: GateCase["expected"],
  column: string,
  value: string | null,
): GateCase => ({
  name,
  expected,
  async prepare(kit) {
    const draft = await kit.draft();
    await kit.setCustomer(kit.customerId, { [column]: value });
    return { session: kit.session, token: draft.token, customerId: kit.customerId };
  },
});

export const GATE_CASES: readonly GateCase[] = [
  bent(
    "no authenticator (TOTP switched off after the draft)",
    "kyc_required",
    "totp_enabled_at",
    null,
  ),
  bent("no verified mobile", "kyc_required", "phone_verified_at", null),
  bent("no verified e-mail", "kyc_required", "email_verified_at", null),
  bent("a suspended customer whose account setup is done", "forbidden", "status", "suspended"),
  {
    // The session says KYC verified: neither the session nor KYC decides, the row's setup facts do.
    name: "a session that says KYC verified over a row without an authenticator",
    expected: "kyc_required",
    async prepare(kit) {
      const draft = await kit.draft();
      await kit.setCustomer(kit.customerId, { kyc_status: "verified", totp_enabled_at: null });
      const session: OrderSession = { ...kit.session, kycStatus: "verified", riskTier: "trusted" };
      return { session, token: draft.token, customerId: kit.customerId };
    },
  },
  {
    // A token that names a customer with no row and no wallet (a wallet cannot exist without a
    // customers row: wallets.customer_id is a foreign key). The lock fails and nothing is written.
    name: "a customer id with no customers row",
    expected: "throws",
    async prepare(kit) {
      const draft = await kit.draft();
      const verdict = verifyDraft(kit.secrets, draft.token, kit.clock.now());
      if (!verdict.ok) throw new Error("gate cases: the draft does not verify");
      const customerId = "0190bbbb-0000-7000-8000-00000000fffd";
      const token = signDraft(kit.secrets, { ...verdict.claims, c: customerId });
      return { session: { ...kit.session, customerId }, token, customerId };
    },
  },
];
