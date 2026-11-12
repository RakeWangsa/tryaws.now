# Single pool account launch (WPU-G1)

Rules: R3 (no long-lived keys, STS AssumeRole only), R7 (idempotent), R10 (admin actions are audited), R16 (fail closed), the management account is never touched. This page is for the stage where the whole platform runs on ONE AWS pool account. The general procedure for any account is [pool-account-onboarding.md](pool-account-onboarding.md); the gaps behind this page are P1, P2, P5 and P9 of [lightsail-parity-gap.md](../analysis/lightsail-parity-gap.md).

## Trigger

The owner has one pool account (roles `TcProvisioner`, `TcReader`, `TcAccessDetails` exist, steps 1 to 6 of the onboarding page are done) and no pool account is registered in the database yet, or `/capacity` of the admin app shows missing cells.

## Who

DevOps with the table-owner database URL of the stage. A Claude Code session does not run this and never sees the URL.

## Steps

1. Record the real Lightsail quotas of the account in the three launch Regions (`ap-southeast-1`, `ap-south-1`, `us-east-1`). A limit above the real quota sells what AWS then refuses (gap P3).
2. Dry run the arguments on the stage: `pnpm seed:pool-account -- --stage staging --aws-account-id <12 digits> --external-id <plain ExternalId> --name <alias> --limits '{"instance_vcpu": <real>, "static_ip": <real>}'`. The command checks every field before it opens a connection. Production needs `--confirm-production`, and only the owner decides that.
3. The command writes one `pool_accounts` row (status `active`, tier `new` unless `--tier` says otherwise) and one `pool_capacity` row per cell: the eight Regional quota codes (`instance_vcpu`, `static_ip`, `database`, `load_balancer`, `container_service`, `certificate_active`, `certificate_365d`, `disk_gb`) in each of the three Regions, and `bucket` and `distribution` once as Region `global`. The `us-east-1` certificate rows also serve distributions. That is 26 rows. Each limit starts as a deliberately low placeholder or your `--limits` value, and `used` starts at 0.
4. Run the same command again: it reports the rows as already there and changes nothing. It never overwrites a limit or a `used` value, and it refuses (writes nothing) when the account id exists with another name, tier or ExternalId, or the name belongs to another account.
5. Open `/capacity` of the admin app and set each limit to the recorded real quota with `setCapacityLimit` (audited, R10). Set the reserve per quota if wanted.
6. Check the catalog: migration 0009 adds the `disk` anchor row for `us-east-1` (P9), so disks can be ordered there; the feature flag `disk` stays off in production (R12). VERIFY the block storage price for `us-east-1` before production.
7. Give the stack its two required settings. `TC_VPC_CIDR` and `TC_PROBE_SOURCES` are environment variables of the deploy shell or of the CI environment, like the other names in `JOURNEY.md`; `readStageConfig` (`infra/lib/stage.ts`) refuses a staging or production deploy without them and says which one is missing, and `infra/stacks/workers.ts` copies both into the provisioner function only. A personal stage may leave them out, and then every Linux create stops before the static IP (R16).
   - `TC_VPC_CIDR`: the verified network of the pool account and Region (the Lightsail VPC), a private (RFC 1918) CIDR between `/16` and `/28`. VERIFY where the Lightsail console and API show it (the VPC peering page of the Region) before the first value is written; DevOps records it per account.
   - `TC_PROBE_SOURCES`: where DevOps gets the NAT addresses. The control plane VPC has one managed NAT gateway per Availability Zone (two), and each has an Elastic IP. The probe connects from those addresses. In the console of the control plane account (`tc-platform` for production, `tc-platform-stg` for staging) open VPC, NAT gateways, and read the "Primary public IPv4 address" of each gateway of the stage's VPC (CLI form for DevOps: `aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=<vpc id>`, field `NatGatewayAddresses[].PublicIp`). The NAT addresses exist only after the first deploy of the network stack, so the first deploy of a stage uses a documentation address (for example `198.51.100.1/32`, which nobody can connect from) and the stack is redeployed with the real addresses; until then no server can be probed and no Linux create finishes. Write each as `/32` and join with commas, for example `198.51.100.10/32,198.51.100.11/32` (documentation addresses). Rules, checked at synth: at most 10 entries, each a public IPv4 `/16` or narrower, never `0.0.0.0/0`, never a private, shared, loopback or link-local range.
     The bootstrap beacon port of a new server is opened to those addresses only, during create, and closed again at the end of create. Without `TC_PROBE_SOURCES` every Linux create stops before the static IP and nothing is opened (R16). The web function needs `PROVISIONING_QUEUE_URL` (the infra stack sets it); without it operations start at the next scheduler sweep instead of within seconds.

## The tier rule with one account

A customer has a risk tier (`new`, `trusted`) and a pool account has a tier; normally a customer is only placed in an account of its own tier. When exactly one pool account is active, that account serves every tier: `decide` (capacity) and the home assignment accept it. With none, or with two or more active accounts, the exact tier match applies again and an order that fits nowhere is refused as `not_configured` (R16). A disabled second account does not count. A home never changes: customers who were placed while only one account existed stay in it after a second account is added; the second account serves new homes by tier.

## Safe checks

`/capacity` shows the account with the right limits and zero use. A test order on staging in each Region reaches `active` only in `tc-pool-dev`. `select count(*) from pool_capacity` is 26 for the account.

## Rollback

Set all limits of the account to 0 with `setCapacityLimit` so no home is assigned. Do not delete rows of an account that hosts customers.

## Log

Account alias (not the id in shared notes), stage, date, who, the real quotas, the case ids of quota requests.

## Must not

Run this against production without the owner; put an AWS account id, ExternalId or any key in a ticket, chat or the repository; create IAM users or access keys; raise a limit above the real AWS quota; use the management account.
