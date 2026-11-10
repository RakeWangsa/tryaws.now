<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 690-748. Change the plan, then run pnpm spec:split. -->

## 3. Architecture

### 3.1 AWS accounts

All accounts are TiCON's own, inside the existing TiCON AWS Organization, in a dedicated OU tree. The Lightsail Partner application is submitted from the management account so member accounts receive higher default instance quotas.

| Account | Purpose | Notes |
| --- | --- | --- |
| Management (existing) | Organizations, SCPs, billing, Lightsail Partner enrollment | No workloads. Hosts the `TcBillingReader` role for Cost Explorer |
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
| `web` (customer Next.js server) | CloudFront + WAF | Database through RDS Proxy; enqueue operations; presign KYC uploads; send email; invoke `reader` | Assume any pool or DNS role; call Lightsail or Route 53; read KYC objects |
| `admin` (admin Next.js server) | CloudFront + WAF with IP allowlist | Same as `web`, plus read KYC objects and approve operations | Assume any pool or DNS role |
| `provisioner` | SQS FIFO queue | Database; assume `TcProvisioner` in listed pool accounts and `TcDnsProvisioner` in `tc-dns` | Be reachable from the internet |
| `reader` | Invoked by `web` and `admin` | Assume `TcReader` (read-only) to fetch live state and metrics for one resource id, after its own tenant check; assume `TcDnsReader` for domain availability, domain status and DNS records | Any write in pool accounts or in `tc-dns` |
| `access-details` | Invoked by `web` | Assume `TcAccessDetails` to fetch a Windows password or a database master password for one resource id, after its own tenant check; writes an audit row | Anything else |
| `invoice-renderer` | Invoked by `web` and `admin` for one invoice, after their own tenant check | Render the invoice HTML to PDF with headless Chromium and write it to the `invoices` bucket | Read the database; reach the internet; assume any role |
| `scheduler` | EventBridge, every minute | Database; enqueue lifecycle operations and notifications | Assume pool roles |
| `payments-sweeper` | EventBridge, every 5 minutes | Database; call EPS verify for pending payments | Assume pool roles |
| `catalog-sync` | Daily and on demand | Assume `TcReader` and `TcDnsReader` (TLD prices); write catalog tables | Change prices of existing subscriptions |
| `reconciler` | Hourly inventory, daily cost | Assume `TcReader` and `TcBillingReader`; write discrepancy rows; alert | Fix discrepancies by itself |
| `migrator` | Deploy time | Run migrations with the migrator database role | Serve traffic |

### 3.3 Network and data stores

- VPC with two AZs, public and private subnets, managed NAT gateway (outbound calls to EPS, AWS APIs and the SMS gateway go through NAT).
- Amazon RDS for PostgreSQL in private subnets: Multi-AZ in production, storage encrypted with a KMS key, automated backups with 14 days point-in-time recovery, deletion protection on, TLS forced, RDS Proxy in front.
- Database roles: `app_rw` (DML only; no UPDATE or DELETE on `ledger_transactions`, `ledger_entries`, `audit_log`), `migrator` (DDL), `report_ro` (read-only).
- S3 buckets, all private with Block Public Access: `kyc` (SSE-KMS, uploads by presigned POST with size and content-type conditions, read only by `admin`), `invoices`, `exports`.
- SQS FIFO queue `provisioning` with a dead-letter queue. MessageGroupId is the resource id, deduplication id is the operation id. An alarm fires when the dead-letter queue is not empty.
- CloudFront in front of both apps. AWS WAF with the AWS managed core, known-bad-inputs and IP-reputation rule groups, plus rate-based rules for login, OTP, top-up and order endpoints.
- CloudTrail (organization trail) and GuardDuty enabled for every account above. Alarms go to an SNS topic that emails the on-call list.

### 3.4 Main flows

Top-up: `web` creates `payments` row -> EPS GetToken -> EPS InitializeEPS -> browser goes to EPS -> EPS returns browser to success, fail or cancel URL -> handler calls EPS CheckMerchantTransactionStatus -> on verified success posts the ledger transaction -> wallet balance updates. The sweeper repeats the verify step for payments whose browser never came back.

Purchase: `web` opens one database transaction: lock wallet row, price the order, check balance, reserve capacity, insert order, subscription, resource, operation, ledger transaction and invoice -> commit -> enqueue operation id -> `provisioner` runs the product adapter step by step -> resource becomes `active` -> notify. Permanent failure posts a reversing ledger transaction and notifies.

Expiry: `scheduler` finds subscriptions at period end -> auto-renew if enabled and funded -> otherwise grace -> suspend -> final snapshot and delete -> snapshot purge. Section 11 has the timings.

