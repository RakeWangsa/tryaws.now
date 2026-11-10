<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 256-393. Change the plan, then run pnpm spec:split. -->

### E.3 Task backlog

Each row is one session-sized task. "Read" names the spec sections the task needs; the same list is in the `/wp-start` skill. Screens are in the task of their data unless a row says otherwise. Days follow Section 14.

**WP0 Foundation (Wed 11, track A with DevOps). Read: 2, 3, 4, 5, 6.3, Appendices.**

| Task | Output | Proof |
| --- | --- | --- |
| WP0-T1 | Repository kit: skeleton, `CLAUDE.md`, `.claude/`, `docs/spec/`, verify script and baseline, CI | `pnpm verify --gate M0` green locally and in CI |
| WP0-T2 | SST app with stages, VPC with two AZs and NAT, hello page behind CloudFront and WAF | `npx sst deploy --stage staging` succeeds; page loads through CloudFront |
| WP0-T3 | RDS PostgreSQL with RDS Proxy, roles `app_rw`, `migrator`, `report_ro`, TLS forced, `migrator` function | A connection from the internet fails; `migrator` runs an empty migration |
| WP0-T4 | Cognito pools for customers and admins (admin TOTP required, email sent through SES), SQS FIFO queue with dead-letter queue, buckets `kyc`, `invoices`, `exports`, alarms to SNS | Deployed outputs listed by `pnpm verify --task WP0-T4` |
| WP0-T5 | `infra/org/`: templates for accounts, OUs, SCPs and the roles of Section 6.3. Applied by DevOps, not by Claude Code | DevOps confirms in `JOURNEY.md`; a test proves the staging web role cannot assume `TcProvisioner` |
| WP0-T6 | By Fri 13: the production control plane deployed once through CI with every feature flag off; SES production access requested on Wed 11 | A tag deploy succeeds after approval; the production web role cannot assume any pool role |

**WP1 Data and pricing (Wed 11, track A). Read: 2 (R4, R5, R8, R15), 7, 8.**

| Task | Output | Proof |
| --- | --- | --- |
| WP1-T1 | Drizzle schema and migrations for every table of Section 7, constraints, ledger balance trigger, grants | `app_rw` cannot UPDATE or DELETE `ledger_entries` and `audit_log`; unbalanced transaction is rejected |
| WP1-T2 | Tenant-scoped repositories and a cross-tenant test helper used by every later endpoint | Helper proves customer A cannot read or write customer B rows |
| WP1-T3 | Pricing engine in `packages/core/pricing` | All Section 8 vectors pass, including both extra vectors |
| WP1-T4 | Markets, FX rates, pricing rules (append-only), feature flags, preview of five products | A new rate never changes a stored order; preview equals engine output |
| WP1-T5 | `catalog-sync` function and config prices | Catalog holds real plans from `tc-pool-dev` with BDT prices; TLD prices loaded |

**WP2 Identity (Wed 11, track C). Read: 2 (R8, R9, R14, R16), 6.1, 16.9, 16.13.**

| Task | Output | Proof |
| --- | --- | --- |
| WP2-T1 | `packages/auth`: token verification, cookie session, `requireCustomer`, fresh sign-in check | A tampered or expired token is rejected; cookies are `HttpOnly`, `Secure`, `SameSite=Lax` |
| WP2-T2 | `/signup`, `/verify` (email), `/login`, `/forgot-password`, `/reset-password` | Playwright completes sign-up to sign-in in `bn` at 360 px |
| WP2-T3 | Phone OTP with the SMS provider adapter | Limits hold: 5 attempts, 3 sends per hour per number and per IP; codes are stored hashed |
| WP2-T4 | `/kyc`: presigned upload, submission, status | The web role cannot read a KYC object; no resource can be created before `verified` |
| WP2-T5 | `/settings/profile`, `/settings/security` | Email or phone change needs a fresh sign-in and a new verification |

**WPU UI kit and shells (Wed 11, track C, second session). Read: 16.1 to 16.7, 16.13, 16.16.**

| Task | Output | Proof |
| --- | --- | --- |
| WPU-T1 | `scripts/sync-theme.ts`, theme assets, `tc.css`, the composite font family | Build output has no file from the theme's `assets/js`; Bengali renders with Noto Sans Bengali |
| WPU-T2 | Kit, part one: `Card`, `Button`, `Field`, `Badge`, `Tabs`, `Accordion`, `Modal`, `ConfirmDestroy`, `Toast`, `DataTable` | Gallery page shows each in `bn` and `en` |
| WPU-T3 | Kit, part two: the remaining components of 16.6 | Same |
| WPU-T4 | Four shells, `next-intl` setup, AWS statements and footers, `/dev/ui`, CSP in report-only mode | The 16.16 checks that apply to the gallery pass |

**WP3 Wallet and EPS (Thu 12, track A; screens with track C). Read: 2 (R4 to R7, R16), 9, 16.10 wallet rows, the `eps-payment-gateway` skill.**

| Task | Output | Proof |
| --- | --- | --- |
| WP3-T1 | Ledger: accounts, `postTransaction`, wallet balance cache, nightly balance check | Balance equals the sum of entries; a wallet cannot go negative |
| WP3-T2 | `packages/eps` client and payment state machine, return handlers under `/pay/eps/` | Replay, forged success URL, amount mismatch and double callback tests credit nothing extra |
| WP3-T3 | `payments-sweeper` function | A payment whose browser never returned is credited by the sweeper once; old ones expire |
| WP3-T4 | `/wallet`, `/wallet/topup`, `/wallet/topup/[paymentId]` | A real top-up on staging credits once and shows the new balance |
| WP3-T5 | Invoices and receipts: numbering, `invoice-renderer`, `/invoices` | PDF matches the sample layout; Bengali text is shaped correctly (VERIFY) |

**WP4 Provisioning core (Thu 12 to Fri 13, track B; screens with track C). Read: 2 (R1, R3, R7, R11, R13), 3.2, 3.4, 6.3, 10, 16.10 server rows, 16.11.**

| Task | Output | Proof |
| --- | --- | --- |
| WP4-T1 | `packages/aws`: STS client with ExternalId, Lightsail client factory, AWS error mapping, retries | The web bundle cannot import it (lint); errors map to platform codes |
| WP4-T2 | Operations engine: table, states, FIFO enqueue, `provisioner` step runner, dead-letter alarm | A step retried three times creates one resource |
| WP4-T3 | Capacity: reservation inside the purchase transaction, release, waitlist | Two concurrent orders for the last slot: one succeeds, one gets the waitlist |
| WP4-T4 | Orders: draft token, `placeOrder`, purchase transaction, automatic reversal on failed create | Double submit with one idempotency key charges once; a failed create refunds once |
| WP4-T5 | Linux instance adapter with key import, static IP and ports | A paid order on staging yields a running instance reachable by SSH with the customer key |
| WP4-T6 | Bootstrap firewall template and the isolation test | `tests/isolation` passes in `tc-pool-dev` |
| WP4-T7 | `/servers`, `/servers/new`, `/orders/review`, `/orders/[id]`, tabs Overview, Access, Networking, `/settings/ssh-keys` | Playwright creates a server at 360 px in `bn` against staging |

**WP5 Instance extras and lifecycle (Fri 13, track B; screens with track C). Read: 10.3, 11, 16.10, 16.14.**

| Task | Output | Proof |
| --- | --- | --- |
| WP5-T1 | Backups, automatic backups, restore to a new server | Restore creates a working server from a snapshot |
| WP5-T2 | Block storage adapter | Create, attach, detach, destroy cycle passes |
| WP5-T3 | `reader` function: live state, metrics, transfer use, with its own tenant check | Customer A cannot read customer B's metrics |
| WP5-T4 | Lifecycle engine with an injectable clock, `scheduler` function | One test instance passes renew, grace, suspend, final snapshot, destroy, restore, purge on the test clock |
| WP5-T5 | `packages/notify`: email through SES, SMS, in-app, templates in `bn` and `en` | Every trigger of 16.14 sends once; no secret in any message |
| WP5-T6 | Tabs Backups, Storage, Metrics, Billing, Destroy; `/dashboard` complete; `/notifications` | Destroy needs the typed name and a fresh sign-in |

**WP6 Gate A (Sat 14, track B). Read: 10.3, 10.4, 16.10 rows of each family.**

| Task | Output | Proof |
| --- | --- | --- |
| WP6-T1 | Windows instance adapter and the `access-details` function | Password is shown once and never stored; bootstrap passes the isolation test |
| WP6-T2 | Managed database adapter and screens | Create, stop, start, snapshot, destroy cycle on the test clock |
| WP6-T3 | Load balancer adapter and screens | Targets limited to the customer's own servers in the same location |
| WP6-T4 | Object storage adapter and screens | Secret key shown once; suspend removes access |

**WP7 Gate B and metering (Sun 15, track B). Read: 10.3, 11 (metered items), 12, 16.10.**

| Task | Output | Proof |
| --- | --- | --- |
| WP7-T1 | Container service adapter and screens | Cycle passes; no registry login is ever issued |
| WP7-T2 | CDN adapter and screens | Cycle passes |
| WP7-T3 | DNS zones and record editor | Apex NS and SOA are read-only; records validate per type |
| WP7-T4 | Domains: search, registration with contact, verification state, renewal | Second confirmation repeats the name; TLDs with extra parameters go to admin review |
| WP7-T5 | Metering: snapshot storage per day, data transfer | Daily charge equals GB x price / 30; 80% and 100% notices sent |
| WP7-T6 | `reconciler`: inventory hourly, cost daily, payments | Zero unexplained resources; cost variance under 2% |

**WP8 Admin (Sat 14 to Sun 15, track D). Read: 2 (R10), 6.2, 13, 16.12.**

| Task | Output | Proof |
| --- | --- | --- |
| WP8-T1 | Admin app: shell, sign-in with TOTP, roles, audit of every action, WAF allowlist | No MFA means no sign-in; outside the allowlist gets 403 |
| WP8-T2 | Customers and KYC review | Document images come through short-lived URLs and are never cached |
| WP8-T3 | Wallets, payments, adjustments with second approval | An adjustment above the limit waits for a second admin |
| WP8-T4 | Pricing, catalog and flags | Saving a rule shows the five-product preview first |
| WP8-T5 | Capacity and the operations queue | A destructive operation runs only after approval (R13) |
| WP8-T6 | Audit search and admin users | Every admin action has an audit row |
| WP8-T7 | Support, abuse, reconciliation (P1) | Listed in 16.12 |

**WPP Public pages (Sat 14, track C). Read: 16.7, 16.8, 16.13, H, L.**

| Task | Output | Proof |
| --- | --- | --- |
| WPP-T1 | `/`, `/pricing`, `/products/cloud-servers` from the live catalog | Prices equal the pricing engine output |
| WPP-T2 | `/help`, `/support`, `/legal/[doc]`, system pages | The four required FAQ answers are present; AWS statements and trademark line on every page |
| WPP-T3 | Metadata, structured data, sitemap, robots, `hreflang` | Public pages indexable, panel `noindex`; Lighthouse accessibility and SEO 90 or more on a phone profile |
| WPP-T4 | P1 pages of gated families with "notify me" | A flag-off family shows the coming soon page |

**WP9 Hardening (Mon 16, all tracks). Read: 15, 16.16, K, M.**

| Task | Output | Proof |
| --- | --- | --- |
| WP9-T1 | Every Section 15 item checked | Evidence for each item in `JOURNEY.md` |
| WP9-T2 | Cross-tenant and isolation sweep over every endpoint | Report with zero gaps |
| WP9-T3 | Database restore drill; purchase concurrency test | Point-in-time restore works; no double spend and no over-reservation under 50 parallel orders with stubbed adapters |
| WP9-T4 | Runbooks of Section M in `docs/runbooks/`; signed-in support form | Each runbook was walked through once |
| WP9-T5 | Wording pass in `bn` and `en`; final legal content | No untranslated key; U6 checks pass |
| WP9-T6 | Beta: 10 to 20 customers with real payments on production with core flags on | Each beta customer has a verified payment and a running server |

**WP10 Launch (Tue 17). Read: K, M.**

| Task | Output | Proof |
| --- | --- | --- |
| WP10-T1 | Flags on for families that passed their gate; monitoring and on-call confirmed | `pnpm verify --gate M7` |
| WP10-T2 | First-day report at 21:00 | Payments verified, no stuck operations, no dead-letter messages, active resources counted |

Critical path for launch day: WP0, WP1, WP2, WPU, WP3, WP4, WP5, the P0 tasks of WP8 and WPP, WP9. WP6, WP7 and every P1 row can slip behind their feature flags without moving the date.

