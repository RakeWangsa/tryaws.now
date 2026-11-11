import type { CapacityNeed } from "./types";

// customerId comes from the session (R8). There is no tier and no market: both are read from the
// customer's row, so no field of the call can say otherwise.
export interface ReserveInput {
  readonly customerId: string;
  readonly region: string;
  readonly needs: readonly CapacityNeed[];
  readonly waitlist?: { readonly productFamily: string; readonly idempotencyKey: string };
}

export type CheckInput = Omit<ReserveInput, "waitlist">;
