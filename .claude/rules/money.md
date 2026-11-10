---
paths:
  - "packages/core/pricing/**"
  - "packages/core/ledger/**"
  - "packages/core/orders/**"
  - "packages/eps/**"
  - "functions/payments-sweeper/**"
---

# Money rules

**R4.** Money is an integer in minor units (paisa, `BIGINT`). Decimal math is allowed only inside the pricing engine with a decimal library. Rounding is half-up. No floats anywhere near money.

**R5.** The ledger is double-entry and append-only. Every transaction balances. Corrections are new reversing transactions, never updates or deletes. The application database role has no UPDATE or DELETE on ledger and audit tables.

**R6.** A wallet is credited only after a server-to-server EPS verification returns success for the same merchantTransactionId and amount. EPS takes and returns no currency: every EPS amount is BDT, and the currency of the payment row is fixed to the market currency when the row is created. Redirect query parameters are untrusted input.

**R7.** Every state-changing request and job is idempotent. An idempotency key is accepted or derived, and a unique constraint enforces it.

**R16.** Fail closed. If a check cannot be completed (EPS verify, KYC status, capacity, authorization), the action is refused.

- Specification: docs/spec/08-pricing-engine.md and docs/spec/09-wallet-ledger-and-eps.md
- Run the pricing vectors after every change in packages/core/pricing.
- A change to a posting rule or to the EPS credit rule needs a "Needs decision" entry first.
