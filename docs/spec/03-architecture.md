<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "3. Architecture". Change the plan, then run pnpm spec:split. -->

## 3. Architecture

### 3.1 AWS accounts

All accounts are TiCON's own, inside the existing TiCON AWS Organization, in a dedicated OU tree. The Lightsail Partner application is submitted from the management account so member accounts receive higher default instance quotas.

| Account | Purpose | Notes |
| --- | --- | --- |
| Management (existing) | Organizations, SCPs, billing, Lightsail Partner enrollment | No workloads and no platform role. Cost Explorer access for member accounts is switched on here |
| `tc-platform` (new) | The production control plane: web, admin, workers, database, queues, buckets | Reached only by the CI deploy role and by named administrators. No developer machine and no Claude Code session holds credentials for it |
| `tc-platform-stg` (new) | The staging control plane: the same stack with its own VPC and database | Developers and Claude Code deploy here. It works only with `tc-pool-dev` and with test zones in `tc-dns` |
| `tc-pool-v1` | Lightsail resources of trusted customers | Lightsail only, by SCP |
| `tc-pool-n1` | Lightsail resources of new customers | Lightsail only, by SCP. Keeps new-customer abuse away from trusted customers |
| `tc-pool-dev` | Lightsail resources created by staging and tests | Never used by production |
| `tc-dns` | Route 53 hosted zones and Route 53 domain registrations | Route 53 only, by SCP |

Rules for pools:

- A customer gets a home pool account per Region on first purchase. All of that customer's resources in the Region stay in the home account, because load balancers, disks, static IPs, private database access and bucket resource access only work inside one account and Region.
- The home account does not change later (Lightsail has no cross-account snapshot copy), so it is chosen once: customers an admin marked `trusted` before their first purchase (existing TiCON Cloud customers, verified businesses) go to `tc-pool-v1`, everyone else goes to `tc-pool-n1`. Later cohorts get new pool accounts (`tc-pool-n2`, ...).
- Only instance vCPU and static IP quotas can be raised. Databases (40 per Region), load balancers (10 per Region), buckets (20 per account), distributions (20 per account), container services (100 per Region) and active certificates (10 per Region, 20 new per 365 days) are fixed. Capacity for these grows only by adding pool accounts, so adding a pool account must be a config change, not a code change.
- New AWS accounts can start below the documented default quotas. Record real quotas per account and Region in `pool_capacity`.

### 3.2 Runtime components and their privileges

Region for the control plane: `ap-southeast-1`. Everything runs on AWS Lambda through SST.

| Component | Trigger | May do | Must not do |
| --- | --- | --- | --- |
| `web` (customer Next.js server) | CloudFront + WAF | Database through RDS Proxy; enqueue operations; presign KYC uploads; insert `notifications` rows through `notify` (the `notifier` sends them); invoke `reader` | Assume any pool or DNS role; call Lightsail or Route 53; read KYC objects |
| `admin` (admin Next.js server) | CloudFront + WAF with IP allowlist | Same as `web`, plus read KYC objects, approve operations, invoke `catalog-sync`, and call the Cognito admin API of the admin pool only | Assume any pool or DNS role |
| `provisioner` | SQS FIFO queue | Database; assume `TcProvisioner` in listed pool accounts and `TcDnsProvisioner` in `tc-dns` | Be reachable from the internet |
| `reader` | Invoked by `web` and `admin` | Assume `TcReader` (read-only) to fetch live state and metrics for one resource id, after its own tenant check; assume `TcDnsReader` for domain availability, domain status and DNS records | Any write in pool accounts or in `tc-dns` |
| `access-details` | Invoked by `web` | Assume `TcAccessDetails` to fetch a Windows password or a database master password, or to create a bucket access key and return its secret once, for one resource id, after its own tenant check; writes an audit row | Anything else |
| `invoice-renderer` | Invoked by `web` and `admin` for one invoice, after their own tenant check | Render the invoice HTML to PDF with headless Chromium and write it to the `invoices` bucket. Runs in the VPC with its own security group whose only egress is HTTPS to S3 through an S3 gateway endpoint; receives self-contained HTML (CSS inlined) and packaged fonts including Noto Sans Bengali; `@sparticuz/chromium` stays outside the bundle, x86_64, about 2 GB memory | Read the database; reach the internet; assume any role |
| `scheduler` | EventBridge Scheduler (`sst.aws.CronV2`), every minute | Database; send the queue message for every `waiting` operation whose `next_run_at` has passed and every `queued` operation still unsent 2 minutes after its `next_run_at` (this recovers a message lost after the purchase committed); enqueue lifecycle operations and notifications | Assume pool roles |
| `payments-sweeper` | EventBridge Scheduler (`sst.aws.CronV2`), every 5 minutes | Database; call EPS verify for pending payments | Assume pool roles |
| `catalog-sync` | Daily and on demand | Assume `TcReader` and `TcDnsReader` (TLD prices); write catalog tables | Change prices of existing subscriptions |
| `reconciler` | Hourly inventory, daily cost | Assume `TcReader`, `TcDnsReader` (hosted zones and domains belong to the inventory) and `TcBillingReader`; measure data transfer every hour and write `usage_records` (Section 11); write discrepancy rows; alert | Fix discrepancies by itself |
| `migrator` | Deploy time | Run migrations with the migrator database role | Serve traffic |
| `notifier` | EventBridge Scheduler (`sst.aws.CronV2`), every minute | Database; read `pending` `notifications` rows, send them through SES or the SMS gateway (`SmsApiKey`) and mark them sent. `notify(tx, ...)` only inserts the row | Assume pool roles |
| `cognito-messages` | Custom message trigger of both Cognito pools | Render Cognito emails (codes, temporary password) in the user's locale with the `packages/notify` layout, under 20,000 characters | Read the database; assume any role |

### 3.3 Network and data stores

- VPC with two AZs, public and private subnets, managed NAT gateway (outbound calls to EPS, AWS APIs and the SMS gateway go through NAT). `invoice-renderer` runs in two isolated subnets with no NAT route and reaches S3 only through an S3 gateway endpoint; its package holds the fonts, and the HTML it receives has its CSS inlined and refers to no URL.
- Amazon RDS for PostgreSQL in private subnets: Multi-AZ in production, storage encrypted with a KMS key, automated backups with 14 days point-in-time recovery, deletion protection on, TLS forced, RDS Proxy in front. `sst.aws.Postgres` defaults differ (`rds.force_ssl` 0, 7-day backups, final snapshot skipped, no deletion protection, the VPC default security group, proxy without `requireTls`): override each through `transform` and give the instance its own security group that admits 5432 only from the proxy.
- Database roles: `web_rw` (customer panel), `admin_rw` (admin panel) and `worker_rw` (functions), each DML only with no UPDATE or DELETE on the append-only (A) tables of Section 7 (`ledger_transactions`, `ledger_entries`, `audit_log`, `legal_acceptances`, `fx_rates`, `pricing_rules`); `web_rw` cannot write `fx_rates`, `pricing_rules`, `feature_flags`, `admin_users`, `pool_accounts` or `pool_capacity` and cannot set `operations.approved_by`; `migrator` (DDL), `report_ro` (read-only). Do not `link` the Postgres component to web, admin or workers: its link carries the master user. List `web_rw`, `admin_rw`, `worker_rw` and `report_ro` in the component's `proxy.credentials` and give each function only its own role's credentials. `migrator` alone uses the master user, to create the roles.
- S3 buckets, all private with Block Public Access: `kyc` (SSE-KMS, uploads by presigned POST with size and content-type conditions, read only by `admin`), `invoices`, `exports`.
- SQS FIFO queue `provisioning` with a dead-letter queue. MessageGroupId is the resource id. The deduplication id is `<operation id>:<enqueue_seq>`, a counter kept on the operation row and increased for every send, never the operation id alone: SQS accepts a second message with the same deduplication id inside 5 minutes, even after the first was deleted, but does not deliver it, so the next step, a repeated wait check or a retry would vanish without an error. An alarm fires when the dead-letter queue is not empty.
- CloudFront in front of both apps. Both `sst.aws.Nextjs` apps set `protection: "oac-with-edge-signing"`, so their Lambda function URLs accept only signed requests from their own distribution and no request can skip the WAF or the admin allowlist. The SST default `"none"` leaves the function URLs public and outside WAF (VERIFY that Server Actions work behind it; request bodies are limited to 1 MB, and KYC files go straight to S3). AWS WAF with the AWS managed core, known-bad-inputs and IP-reputation rule groups, plus rate-based rules for login, OTP, top-up and order endpoints. Server Actions POST to the page URL, so these rules match method POST on those page paths in both locales and on `/pay/eps/`. The web ACLs and the admin IP set are created in us-east-1 (a second provider) and attached through `transform.cdn` (`webAclArn`).
- CloudTrail (organization trail) and GuardDuty enabled for every account above. Alarms go to an SNS topic that emails the on-call list.

### 3.4 Main flows

Top-up: `web` creates `payments` row -> EPS GetToken -> EPS InitializeEPS -> browser goes to EPS -> EPS returns browser to success, fail or cancel URL -> handler calls EPS CheckMerchantTransactionStatus -> on verified success posts the ledger transaction -> wallet balance updates. The sweeper repeats the verify step for payments whose browser never came back.

Purchase: `web` opens one database transaction: lock wallet row, check customer status, KYC, feature flag and risk-tier limits again, price the order, check balance, reserve capacity, insert order, subscription, resource, operation, ledger transaction and invoice -> commit -> send the operation id to the queue (after commit, outside the transaction; `enqueueOperation(tx, ...)` only inserts the row as `queued` with `next_run_at` = now, and if the send is lost the `scheduler` sends it, 3.2) -> `provisioner` runs the product adapter step by step -> resource becomes `active` -> notify. Permanent failure posts a reversing ledger transaction and notifies.

Expiry: `scheduler` finds subscriptions at period end -> auto-renew if enabled and funded -> otherwise grace -> suspend -> final snapshot and delete -> snapshot purge. Section 11 has the timings.

