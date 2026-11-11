// What a customer sees of a payment row (9.2.4 and contract F): initiated, redirected and review
// are all "pending". This is the same table as `publicState` of @tc/eps; the screens keep their own
// copy so that a page does not import the whole EPS barrel (which also holds the in-memory
// gateway). payment-state.test.ts compares the two for every stored state.
export type PublicPaymentState = "credited" | "pending" | "failed" | "cancelled" | "expired";

export function publicPaymentState(status: string): PublicPaymentState {
  switch (status) {
    case "credited":
    case "failed":
    case "cancelled":
    case "expired":
      return status;
    default:
      // initiated, redirected, review, and anything unknown: nothing is promised (R16).
      return "pending";
  }
}

/** Open for the customer's count: the gateway has not given a final answer, or staff must look (review). */
export function isWaiting(status: string): boolean {
  return publicPaymentState(status) === "pending";
}
