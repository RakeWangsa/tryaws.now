---
paths:
  - "apps/**"
  - "functions/**"
  - "packages/auth/**"
  - "packages/core/operations/**"
  - "**/package.json"
  - "pnpm-lock.yaml"
---

# Server rules

**R6.** A wallet is credited only after a server-to-server EPS verification returns success for the same merchantTransactionId and amount. EPS takes and returns no currency: every EPS amount is BDT, and the currency of the payment row is fixed to the market currency when the row is created. Redirect query parameters are untrusted input.

**R7.** Every state-changing request and job is idempotent. An idempotency key is accepted or derived, and a unique constraint enforces it.

**R8.** Tenant scoping: customer data is read and written only through repository functions that take `customerId` from the verified session, never from the request body, query or path. Each endpoint has a cross-tenant (IDOR) test.

**R9.** Order of work in every server action and route handler: authenticate, authorize, validate with zod, rate limit, execute, write audit log.

**R14.** Logs are structured JSON and contain no passwords, tokens, EPS secrets, ID document numbers, or full phone numbers and emails.

**R16.** Fail closed. If a check cannot be completed (EPS verify, KYC status, capacity, authorization), the action is refused.

**R17.** Dependencies are pinned by lockfile. No high or critical advisories at release. No new auth or crypto dependency without a recorded reason.

- Specification: docs/spec/02-rules-that-are-never-broken.md and docs/spec/06-identity-and-access.md
