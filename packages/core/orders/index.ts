// The public surface of the order flow, and nothing else. `signDraft` and `assertSecrets` stay in
// token.ts for the tests and for `makeOrders`; a Server Action must not be able to mint a token.
// `testkit` helpers are never exported. exports.test.ts lists the value names below.
export { createOrderDraft, placeOrder } from "./production";
export { makeOrders, type Orders } from "./place";
export type { OrdersDeps } from "./draft";
export { CLIENT_KEY, DRAFT_TTL_SECONDS, type OrderDraft, type OrderSession } from "./types";
export { verifyDraft } from "./token";
export { draftHash, orderIdFor } from "./ids";
export { comparePrice } from "./compare";
export { DEFAULT_TIER_LIMITS, checkCustomer, checkLimits } from "./gates";
export { runPurchase } from "./purchase";
export { compensateFailedCreate, type Compensated } from "./compensate";
