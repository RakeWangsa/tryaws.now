<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "14. Work packages". Change the plan, then run pnpm spec:split. -->

## 14. Work packages

Run tracks in parallel in separate worktrees: A (core and money: WP0, WP1, WP3), B (provisioning: WP4, WP5, WP6, WP7), C (identity and UI: WPU, WP2, WPP, and the screens of every package), D (admin: WP8). Packages are the boundaries; do not edit another track's package without noting it in `JOURNEY.md`.

Screens belong to the work package named in Section 16. A work package that owns screens is done only when those screens work against real data on staging in `bn` and `en` and pass the checks of Section 16.16. Track C builds each screen against the Server Actions and repository functions that tracks A, B and D expose. Until an action exists the screen uses a typed stub with the same signature.

UI review checkpoint: Thursday 12, evening. Sign-up, top-up and the create-server flow are shown to Moshiur on staging in the mockup's look, so changes to look or wording land before the weekend.

Each work package is broken into session-sized tasks in Section E.3, and each day ends with a gate of Section G.

| WP | Day | Scope | Acceptance tests |
| --- | --- | --- | --- |
| WP0 Foundation | Wed 11 | Monorepo, SST app with stages, VPC, RDS and proxy, Cognito pools, queue, buckets, WAF, CI (lint, typecheck, test), the Claude Code kit of Appendices P to T | `sst deploy --stage staging` succeeds; database is not reachable from the internet; a hello page loads through CloudFront; CI is green |
| WP1 Data and pricing | Wed 11 | Schema and migrations, database roles, pricing engine, markets, FX and rules, catalog sync from `tc-pool-dev` | All Section 8 vectors pass; no application role can UPDATE `ledger_entries`; catalog shows real bundles with BDT prices |
| WP2 Identity | Wed 11 | Sign-up, sign-in, sessions in cookies, phone OTP, KYC upload and status | JWT tampering is rejected; OTP limits hold; KYC object is not readable by the web role; no resource creation before `verified` (proved in WP4-T4) |
| WPU UI kit and shells | Wed 11 | Section 16.3 to 16.7: theme sync, fonts, tokens, component kit, four shells, i18n scaffolding, `/dev/ui` gallery | The gallery passes the checks of Section 16.16 that apply to it; the build output has no file from the theme's `assets/js` |
| WP3 Wallet and EPS | Thu 12 | Ledger, wallet, top-up flow, sweeper, receipts, invoice data | Real top-up credits once; replayed callback credits nothing; forged success URL credits nothing; amount mismatch credits nothing; balance equals ledger sum |
| WP4 Provisioning core | Thu 12 to Fri 13 | Pool accounts and roles, capacity, operations and queue, Linux instance adapter, keys, bootstrap firewall, static IP, firewall rules | Paid order yields a running instance reachable by SSH with the customer key; a failed create refunds once; isolation test passes; web role cannot assume `TcProvisioner` |
| WP5 Instance extras and lifecycle | Fri 13 | Snapshots, auto backups, disks, metrics through `reader`, reboot, stop and start, lifecycle engine, scheduler, notifications, restore | One test instance goes through renew, grace, suspend, final snapshot, destroy, restore and purge on the test clock |
| WP6 Gate A | Sat 14 | Windows, managed database, load balancer, object storage adapters | Each adapter passes create, suspend, resume, destroy on the test clock in `tc-pool-dev` |
| WP7 Gate B and metering | Sun 15 | Containers, CDN, DNS, domains; snapshot and transfer metering; reconciler | Each adapter passes its cycle; reconciler reports zero unexplained resources and cost variance under 2% |
| WP8 Admin | Sat 14 to Sun 15 | Sections 13 and 16.12 | Admin without MFA cannot sign in; admin outside the allowlist gets 403; every action writes an audit row |
| WPP Public pages | Sat 14 | The P0 pages of Section 16.8, fed by the live catalog; metadata, structured data, sitemap | Prices on `/pricing` equal the pricing engine output for the same products; public pages are indexable and panel routes are `noindex`; Lighthouse accessibility and SEO scores of 90 or more on a phone profile |
| WP9 Hardening | Mon 16 | Section 15, backup restore drill, 10 to 20 beta customers with real payments, final legal page content, wording pass in `bn` and `en`, signed-in support form | Every Section 15 item is checked with evidence in `JOURNEY.md` |
| WP10 Launch | Tue 17 | Feature flags on for products that passed, monitoring, on-call | First-day dashboard: payments verified, no stuck operations, no dead-letter messages |

