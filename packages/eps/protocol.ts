// EPS protocol constants. Source: team skill eps-payment-gateway (EPS V5 guide, Dec 2025).
// No live call was made; every value below is VERIFY (open points 6.n). A correction is a one-file change.

// VERIFY (open point 6.1): base URLs of the two environments.
export const EPS_BASE_URL = {
  production: "https://pgapi.eps.com.bd",
  sandbox: "https://sandboxpgapi.eps.com.bd",
} as const;

// VERIFY (open point 6.1): paths of token, initialize and verify.
export const EPS_PATH = {
  token: "/v1/Auth/GetToken",
  initialize: "/v1/EPSEngine/InitializeEPS",
  verify: "/v1/EPSEngine/CheckMerchantTransactionStatus",
} as const;

// VERIFY (open point 6.3): query parameter names EPS may append to the return URLs; the first present is read.
export const EPS_MERCHANT_TRANSACTION_PARAM_NAMES = [
  "MerchantTransactionId",
  "merchantTransactionId",
  "merchant_transaction_id",
] as const;
