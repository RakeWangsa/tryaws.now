---
paths:
  - "packages/core/lifecycle/**"
  - "functions/scheduler/**"
---

# Lifecycle rules

**R4.** Money is an integer in minor units (paisa, `BIGINT`). Decimal math is allowed only inside the pricing engine with a decimal library. Rounding is half-up. No floats anywhere near money.

**R5.** The ledger is double-entry and append-only. Every transaction balances. Corrections are new reversing transactions, never updates or deletes. The application database role has no UPDATE or DELETE on ledger and audit tables.

**R7.** Every state-changing request and job is idempotent. An idempotency key is accepted or derived, and a unique constraint enforces it.

**R13.** Destructive lifecycle actions (delete instance, database, disk, bucket, snapshot, release static IP) run only when the subscription state allows it and a final snapshot exists where the product supports one. Until 2026-12-01 they also need admin approval in the operations queue.

**R16.** Fail closed. If a check cannot be completed (EPS verify, KYC status, capacity, authorization), the action is refused.

- Specification: docs/spec/11-lifecycle-engine.md
- Time comes from the injected Clock only.
