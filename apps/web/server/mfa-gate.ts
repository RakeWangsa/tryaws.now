import type { TotpPort } from "@tc/auth";
import type { Orders } from "@tc/core";

// WPU-X11 round 2 (security review, finding 2c). The authenticator is a fact of the customers row for the
// purchase code (packages/core cannot call Cognito), and Cognito holds the real setting. A customer can
// switch it off outside the panel: with their own access token on the public endpoint, with a stolen
// token, or through support. A session that was open before then would keep buying on the stale copy.
// So every draft and every purchase, of every product family, first asks Cognito for the setting of the
// session's own user (GetUser with the access token of this request) and goes on only when
// UserMFASettingList names the software token. A call that cannot be made or understood refuses (R16).
// Where the answer is a clear "off", the platform copy is cleared and audited (onDrift), so the
// dashboard and the buy screens tell the truth too.
//
// R1: this is an identity call (the customer pool, the customer's own token), not provisioning.

export interface MfaGateDeps {
  /** null = the customer pool is not configured: every draft and purchase refuses. */
  readonly totp: Pick<TotpPort, "mfaState"> | null;
  /** The access token of this request's session cookie; null when there is none. */
  accessToken(): string | null;
  /** Cognito says off while the platform says on: clear the copy and audit it. Its failure changes nothing. */
  onDrift(customerId: string): Promise<void>;
}

type Refusal = {
  ok: false;
  error: "kyc_required" | "upstream_unavailable";
  data?: { missing: ["totp"] };
};

export function mfaGuardedOrders(orders: Orders, deps: MfaGateDeps): Orders {
  async function gate(customerId: string): Promise<Refusal | null> {
    const token = deps.accessToken();
    if (deps.totp === null || token === null || token === "") {
      return { ok: false, error: "upstream_unavailable" };
    }
    let state;
    try {
      state = await deps.totp.mfaState(token);
    } catch {
      // The text of a thrown error may hold the token (R14): nothing of it is kept.
      return { ok: false, error: "upstream_unavailable" };
    }
    if (!state.ok) return { ok: false, error: "upstream_unavailable" };
    if (state.value.totp) return null;
    try {
      await deps.onDrift(customerId);
    } catch {
      // The refusal stands whether or not the copy could be cleared.
    }
    return { ok: false, error: "kyc_required", data: { missing: ["totp"] } };
  }

  return {
    createOrderDraft: async (session, input) =>
      (await gate(session.customerId)) ?? orders.createOrderDraft(session, input),
    placeOrder: async (session, input) =>
      (await gate(session.customerId)) ?? orders.placeOrder(session, input),
  };
}
