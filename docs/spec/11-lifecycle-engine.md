<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "11. Lifecycle engine". Change the plan, then run pnpm spec:split. -->

## 11. Lifecycle engine

Subscription states: `active`, `grace` (resource suspended, data intact), `retained` (resource destroyed, final snapshot kept), `ended` (snapshots purged). All timings are config values read through an injectable clock so the whole cycle can be tested in minutes.

| When | Action |
| --- | --- |
| 7, 3 and 1 day before period end | Reminder by email with the renewal amount at today's rate and the wallet balance; SMS only at 1 day (16.14) |
| Period end, auto-renew on, wallet funded | Charge, extend 30 days, invoice |
| Period end, not renewed | State `grace`. Suspend the resource (Section 10.3). Notify |
| During grace | Customer pays: resume the resource, new period starts from the old period end. Paying means `renewNow`, or, with auto-renew on, the `scheduler` itself: it tries the renewal again on every run and renews as soon as the wallet covers the amount |
| Period end + 48 hours | State `retained`. Final snapshot, then destroy the resource. Needs admin approval until 2026-12-01. Notify |
| During retention | Customer pays: restore from the final snapshot, new period starts at restore time. A family without a final snapshot (load balancer, container service, CDN, DNS) keeps its configuration in `resources.config` and is created again from it; its endpoint changes and the badge and email say "settings kept" |
| Destroy + 14 days | State `ended`. Purge snapshots. Notify |
| Any time | A resource suspended by an admin (`suspendResource`) stays suspended: a renewal or payment never resumes it; only an admin action does |

Metered items: snapshot storage is charged daily at (GB x price per GB-month / 30). Data transfer is measured hourly from instance metrics by the `reconciler` through `TcReader` and written to `usage_records`; notify at 80% and 100% of the bundle allowance; above 100% buy 50 GB packs from the wallet if the customer enabled it, otherwise close public ports until the next period. If a daily charge cannot be paid the item enters the same grace flow.

