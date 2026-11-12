# One account and the lean stage (WPU-B8)

Rules: R2 (database private, RDS Proxy, TLS), R3 (no long-lived keys, STS AssumeRole only), R12 (feature flags), R13 (final snapshot), R16 (fail closed), the management account is never touched. This page is for the stage where the control plane, the one pool account and the DNS role all live in ONE AWS account, sized to stay under about 50 USD a month. For the pool account registration itself see [pool-account-single.md](pool-account-single.md); the general procedure for any further account is [pool-account-onboarding.md](pool-account-onboarding.md).

## The one-account ruling

The owner decided (`JOURNEY.md`, 2026-11-13) that one AWS account holds everything:

- It is a MEMBER account of the organisation, never the management account. Deploying there does not touch the management account.
- The control plane, the single pool account and the DNS role are the same account. `TC_ACCOUNT_ID`, `TC_POOL_ACCOUNT_IDS` and `TC_DNS_ACCOUNT_ID` carry the same id. The id has 12 digits and exists only in the GitHub variable `TC_ACCOUNT_ID` (and the matching names above); it is never written in the repository, a ticket or a chat.
- The cross-account roles `TcProvisioner`, `TcReader`, `TcAccessDetails` and the DNS roles are deployed in that same account and still assumed by STS with their ExternalIds (R3). No IAM user and no access key is added because the account is shared.
- Cost if the ruling is wrong: weaker blast-radius isolation. A mistake in a platform role or policy can reach customer Lightsail resources in the same account, and a customer-side incident shares quotas and limits with the platform. The three-account design (control plane, pool, DNS) stays the target when revenue allows; the way back is below.

## Trigger

The owner wants to run the platform on one account within the 50 USD a month budget, or the budget alarm of this stage sent a message (see "At the 40 USD and 50 USD alarm").

## Who

The owner or DevOps with the deploy rights of the stage. A Claude Code session never deploys this stage and never sees the values of the variables, the account id or any secret.

## Steps

1. Decide the size. The deploy shell or the CI environment sets `TC_STAGE_SIZE` to `lean` or `full`. Unset means `full`. Any other value refuses the deploy before anything is created (R16). Production changes size only when the owner sets it explicitly.
2. Set the three account variables to the same 12 digit id, in the GitHub variables and the CI environment only: `TC_ACCOUNT_ID`, `TC_POOL_ACCOUNT_IDS`, `TC_DNS_ACCOUNT_ID`. Deploy the roles of steps 1 to 6 of the onboarding page into this account, then follow [pool-account-single.md](pool-account-single.md) to register the account and set the real Lightsail quotas.
3. Set `TC_VPC_CIDR` as in [pool-account-single.md](pool-account-single.md). Set `TC_PROBE_SOURCES` to the address of the single NAT instance (one `/32`). The address exists only after the first deploy of the network stack, so the first deploy uses a documentation address (for example `198.51.100.1/32`), and the stack is redeployed with the real address. Until then no server can be probed and no Linux create finishes. VERIFY after the first deploy that SST makes one NAT instance for the whole VPC and not one per Availability Zone; if it makes two, list both addresses.
4. Add the alarm e-mail addresses to the stage settings. Each address receives a subscription message from Amazon SNS and the subscription stays pending until that person confirms it. An unconfirmed address gets no budget or alarm mail.
5. Deploy through the CI role after approval (never by hand, never a Claude Code session). The owner starts it.
6. What `lean` sets:
   - Database: `db.t4g.micro`, single zone, 20 GB storage, backups kept 7 days. RDS Proxy stays (R2). TLS only, KMS encryption, deletion protection and the final snapshot stay.
   - Network: one small NAT instance instead of two NAT gateways. Two Availability Zones stay because the database subnet group needs two.
   - WAF: a minimal web ACL with the Common managed group, the rate rules for login, signup, verify, wallet and eps-return, and the admin IP allowlist. The other managed groups of `full` are not attached.
   - Logs: Lambda log groups keep 7 days.
   - Budget: an AWS Budgets monthly cost budget with a limit of 50 USD and two notifications on ACTUAL spend, at 40 USD and at 50 USD, sent to the alarm SNS topic.
7. After the deploy, confirm every e-mail subscription of the alarm topic, then run the safe checks.

## Cost per line item

Estimate, not measured: check the AWS pricing pages and Cost Explorer after 7 days. No price below is a quote. The 50 USD is the ceiling the alarm watches, not a forecast that the lines add up to it.

| Line item                    | Lean setting                | What drives the cost                                               | Figure                                                |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Database instance            | `db.t4g.micro`, single zone | instance hours, 730 hours a month, Region price                    | VERIFY on the RDS pricing page                        |
| Database storage and backups | 20 GB, 7 days               | GB-month, backup storage above the free allowance                  | VERIFY                                                |
| RDS Proxy                    | one proxy                   | vCPU-hours of the instance behind it, so the minimum for a micro   | VERIFY on the RDS Proxy pricing page                  |
| NAT                          | one small NAT instance      | instance hours, data processed through it, one public IPv4 address | VERIFY; compare with 2 NAT gateways (hourly + per GB) |
| Public IPv4 addresses        | NAT, load balancer if any   | hourly charge per public address                                   | VERIFY                                                |
| Lambda, SQS, EventBridge     | pay per use                 | requests and duration; low at launch volume                        | VERIFY in Cost Explorer after 7 days                  |
| WAF                          | one web ACL, few rules      | web ACL, rules and requests (monthly fee per ACL and per rule)     | VERIFY on the WAF pricing page                        |
| CloudWatch logs              | 7 days retention            | ingested GB and stored GB                                          | VERIFY in Cost Explorer after 7 days                  |
| Route 53                     | hosted zones                | monthly fee per zone, queries; grows with customer domains         | VERIFY                                                |
| KMS, Secrets Manager         | few keys and secrets        | monthly fee per key and secret, requests                           | VERIFY                                                |
| Customer Lightsail resources | sold to prepaid customers   | paid from the customer wallet, not part of the platform budget     | counted in the account bill; see below                |

Customer Lightsail resources run in the same account, so they appear on the same bill and count against the same Budgets alarm. A fast-growing customer base reaches the 40 and 50 USD alarms for a good reason; read the alarm as "check", not as "fault".

## What lean gives up

- The database is in one Availability Zone. A zone failure or maintenance takes it down until it recovers; recovery is the restore of [restore-drill.md](restore-drill.md).
- One NAT instance is one point of failure for the outbound traffic of the functions in the VPC, and has less bandwidth than gateways.
- Backups reach back 7 days, logs 7 days. An incident older than a week has no log to read.
- Fewer WAF managed groups. Common rules and the rate rules stay; known-bad-input and reputation groups of `full` are absent.
- A shared account: blast radius as in the ruling above.

## At the 40 USD and 50 USD alarm

At 40 USD (ACTUAL spend):

1. Open Cost Explorer for the account, group by service, and compare with the table above. Name the line that grew.
2. Check whether customer Lightsail usage grew (expected, paid by wallets) or a platform line grew (NAT data, logs, WAF requests).
3. Write the finding in the log. No action is required if the growth is customer usage.

At 50 USD (ACTUAL spend):

1. Repeat the 40 USD review and decide with the owner: accept and raise the budget limit, or reduce.
2. To reduce, in this order: shorten log retention further, remove a feature family that is not selling (feature flags stay off in production, R12), stop non-essential stacks. Do not delete the database, the snapshots or customer resources, and do not weaken TLS, KMS, deletion protection or the WAF rate rules to save money.
3. A new customer purchase must not be blocked silently: if capacity or provisioning is stopped, say so on the status page and in the support inbox ([support-requests.md](support-requests.md)).

## Safe checks

`TC_STAGE_SIZE` unset deploys `full`; a wrong word is refused before any resource. After the deploy: the database shows `db.t4g.micro`, not multi-AZ, 7 day backups, deletion protection on, TLS required on the proxy; there is one NAT address and it equals `TC_PROBE_SOURCES`; the web ACL has the Common group and the rate rules; Lambda log groups show 7 days; the budget shows 50 USD monthly with the 40 and 50 USD notifications; every alarm e-mail subscription is confirmed (not pending). `/capacity` of the admin app shows the account with the real limits ([pool-account-single.md](pool-account-single.md)).

## Rollback

To `full` on the same account: unset `TC_STAGE_SIZE` (or set `full`), redeploy through CI after approval. The network gets managed NAT gateways, the log retention becomes 14 days, the other WAF managed groups return, and on a production stage the database becomes `db.t4g.medium` and Multi-AZ (on other stages it stays `db.t4g.micro` single-zone, with 14 day backups), so `TC_PROBE_SOURCES` must be replaced with the two gateway addresses (first deploy with documentation addresses, then redeploy, as above). Expect a short interruption while the database or network changes; do it in a quiet hour and announce it. The cost of `full` is higher; check the budget limit first.

To separate accounts: follow [pool-account-onboarding.md](pool-account-onboarding.md) for a new pool account, register it, set its real limits, then move new homes there (a home never moves by itself: customers placed in the shared account stay until a planned migration). Create the DNS account separately and point `TC_DNS_ACCOUNT_ID` to it. Change variables one at a time and redeploy after each. Rotate any ExternalId that was ever written outside the CI secrets ([secret-rotation.md](secret-rotation.md)).

## Log

Stage, date, who, the size (`lean` or `full`), the alarm that fired and the Cost Explorer finding, the decision. Account alias only, never the id.

## Must not

Put the account id, an ExternalId or any key in the repository, a ticket or a chat; deploy this stage from a Claude Code session or by hand; use the management account; create IAM users or access keys; run a size other than `lean` or `full`; remove RDS Proxy, TLS, KMS, deletion protection or the final snapshot to save money; claim a figure of the cost table as measured before Cost Explorer shows it; skip the confirmation of the alarm e-mail subscriptions.
