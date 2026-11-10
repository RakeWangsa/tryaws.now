<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 1034-1049. Change the plan, then run pnpm spec:split. -->

## 11. Lifecycle engine

Subscription states: `active`, `grace` (resource suspended, data intact), `retained` (resource destroyed, final snapshot kept), `ended` (snapshots purged). All timings are config values read through an injectable clock so the whole cycle can be tested in minutes.

| When | Action |
| --- | --- |
| 7, 3 and 1 day before period end | Reminder by email and SMS with the renewal amount and wallet balance |
| Period end, auto-renew on, wallet funded | Charge, extend 30 days, invoice |
| Period end, not renewed | State `grace`. Suspend the resource (Section 10.3). Notify |
| During grace | Customer pays: resume the resource, new period starts from the old period end |
| Period end + 48 hours | State `retained`. Final snapshot, then destroy the resource. Needs admin approval until 2026-12-01. Notify |
| During retention | Customer pays: restore from the final snapshot, new period starts at restore time |
| Destroy + 14 days | State `ended`. Purge snapshots. Notify |

Metered items: snapshot storage is charged daily at (GB x price per GB-month / 30). Data transfer is measured hourly from instance metrics; notify at 80% and 100% of the bundle allowance; above 100% buy 50 GB packs from the wallet if the customer enabled it, otherwise close public ports until the next period. If a daily charge cannot be paid the item enters the same grace flow.

