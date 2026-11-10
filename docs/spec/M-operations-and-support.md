<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 595-608. Change the plan, then run pnpm spec:split. -->

## M. Operations and support

| Routine | When | Who |
| --- | --- | --- |
| KYC queue | Continuously in working hours; under 2 hours in launch week | Operations lead |
| Operations queue (approvals, needs attention) | Three times a day; at once on an alarm | Track B driver until day 14, then operations |
| Payments in `pending` over 30 minutes | Twice a day | Finance admin |
| Reconciliation report | Every morning | Finance admin and DevOps |
| Capacity per pool account and Region | Every morning; quota request at 70% use | DevOps |
| Abuse notices from AWS | Within 24 hours: suspend the resource, open a case, answer AWS | Operations lead |
| Support inbox | First answer within 1 working hour in launch week | Operations lead |

Runbooks that task WP9-T4 writes into `docs/runbooks/`, one page each with symptoms, checks, actions and who decides: payment stuck or disputed; EPS unavailable (manual top-up by a `finance` admin with a bank or wallet receipt); provisioning failed; capacity full; lifecycle approval; abuse notice; KYC review; refund; domain registration problem; reconciliation mismatch; database restore; incident (severity levels, who is told, customer notice).

