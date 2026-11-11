// States are the values of payments_status_check (open point 1): created = initiated, succeeded = credited,
// and "verifying" is the row lock held during a verify, not a stored state.
export const PAYMENT_STATES = [
  "initiated",
  "redirected",
  "credited",
  "failed",
  "cancelled",
  "expired",
  "review",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const OPEN_STATES = ["initiated", "redirected"] as const;

export function isOpen(s: PaymentState): boolean {
  return s === "initiated" || s === "redirected";
}

const MOVES: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  initiated: ["redirected", "credited", "failed", "cancelled", "expired", "review"],
  redirected: ["credited", "failed", "cancelled", "expired", "review"],
  credited: [],
  failed: ["review"],
  cancelled: ["review"],
  expired: ["review"],
  review: [],
};

/** Exactly the table of the plan. credited and review have no outgoing move; nothing moves to initiated. */
export function canMove(from: PaymentState, to: PaymentState): boolean {
  return Object.hasOwn(MOVES, from) && MOVES[from].includes(to);
}

export type PublicState = "credited" | "pending" | "failed" | "cancelled" | "expired";

/** What a customer sees (9.2.4 and F): initiated, redirected and review are all pending. */
export function publicState(s: PaymentState): PublicState {
  switch (s) {
    case "credited":
    case "failed":
    case "cancelled":
    case "expired":
      return s;
    default:
      return "pending";
  }
}

export interface StoredPayment {
  id: string;
  customerId: string;
  amountMinor: bigint;
  currency: string;
  status: PaymentState;
  merchantTransactionId: string;
  gatewayTransactionId: string | null;
  createdAt: Date;
}

export type Action =
  | { type: "credit"; gatewayTransactionId: string | null }
  | { type: "move"; to: "failed" | "cancelled" }
  | {
      type: "review";
      reason: "amount_mismatch" | "id_mismatch" | "late_success" | "gateway_id_reused" | "currency";
    }
  | { type: "noop"; reason: "pending" | "unknown" | "closed" | "already_credited" | "in_review" };
