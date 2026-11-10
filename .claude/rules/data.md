---
paths:
  - "packages/db/**"
---

# Data rules

**R5.** The ledger is double-entry and append-only. Every transaction balances. Corrections are new reversing transactions, never updates or deletes. The application database role has no UPDATE or DELETE on ledger and audit tables.

**R8.** Tenant scoping: customer data is read and written only through repository functions that take `customerId` from the verified session, never from the request body, query or path. Each endpoint has a cross-tenant (IDOR) test.

**R15.** Pricing, ledger, lifecycle and capacity allocation have unit tests. Nothing merges with failing tests. Migrations are forward-only.

- Every new repository method takes the tenant scope and gets a cross-tenant test.
