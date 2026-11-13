# TryAWS.now

**Prepaid cloud servers for Bangladesh, built on 100% AWS infrastructure.**
Pay in taka from a wallet, launch a server in minutes, and get support in Bangla or English, with no
dollar card needed.

[Website](https://tryaws.now) · [Go-live runbook](docs/runbooks/go-live.md) ·
[Runbooks](docs/runbooks/README.md) · [Engineering journal](JOURNEY.md)

---

## Why TryAWS.now

Bangladeshi developers, agencies and small businesses want AWS-grade infrastructure, but they hit three walls:

| Problem                                               | What TryAWS.now does                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| AWS bills in USD and needs an international card      | A **prepaid BDT wallet**, topped up through the local **EPS** payment gateway |
| Prices change with the dollar rate and VAT is unclear | **All-in BDT prices**, 5% VAT included, with a VAT invoice for every charge   |
| The AWS console is hard for a first server            | A **simple panel** in Bangla and English, and in-app support tickets          |

Customer resources run on **Amazon Lightsail** in TryAWS.now's AWS accounts. Domains and DNS run on
**Amazon Route 53**.

## Products

Every product family sits behind its own feature flag, and every flag is **off by default in production**.
Each family is switched on only after it has been proven on staging.

| Family                                  | What the customer gets                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Linux and Windows servers               | Lightsail instances: plans, Regions, OS and app images (WordPress, LAMP, Node.js, Nginx) |
| Block storage disks                     | Attach, detach and snapshot; a disk is deleted together with its server                  |
| Managed databases                       | Lightsail MySQL and PostgreSQL                                                           |
| Object storage                          | Lightsail buckets with access keys                                                       |
| Load balancers, CDN, container services | The Lightsail services, billed from the same wallet                                      |
| Static IPs and backups                  | Add-ons of a server                                                                      |
| Domains and DNS zones                   | Registration and renewal through Route 53, renewed 30 days before expiry                 |

**Money rules customers can rely on:**

- Prepaid only.
- Every charge is in the ledger.
- Auto-renew is on at purchase and can be switched off on the service's page.
- A refund goes back to the wallet with a credit note.

## Status

| Milestone                                                    | State                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| Platform code (panel, admin, billing, provisioning, support) | Done and reviewed; every task has a `pnpm verify --task` proof |
| Go-live kit (CI roles, secrets script, runbooks)             | Done                                                           |
| Staging test session and the two manual staging proofs       | **Next**: owner, see [go-live](docs/runbooks/go-live.md)       |
| Production at tryaws.now, buying **off**                     | After the `v0.1.0` tag                                         |
| Buying **on**, one product family at a time                  | After live EPS payments are proven on staging                  |

## Architecture at a glance

```
Customer ─▶ CloudFront + WAF ─▶ Next.js panel (apps/web) ──┐
Admin ────▶ CloudFront + WAF ─▶ Next.js admin (apps/admin) ┤  write an operation row,
                                                           │  never call AWS directly (R1)
                                                           ▼
                         PostgreSQL (private, RDS Proxy, TLS) ◀── Lambda workers (functions/)
                                                           │      provisioner, scheduler,
                                                           │      reconciler, notifier, ...
                                                           ▼
                                   Pool accounts (Lightsail) and the DNS account (Route 53)
                                   reached only through STS AssumeRole
```

- **Web tier never provisions:** the apps write an operation row and enqueue it. Lambda workers in the VPC
  do the AWS work.
- **Double-entry, append-only ledger** in integer paisa. A correction is a reversing transaction, never an
  edit.
- **Idempotent everything:** every state-changing request and job carries a unique key.
- **Tenant isolation:** customer data is read only through tenant-scoped repositories, and every endpoint
  has a cross-tenant test.
- **Fail closed:** if a check cannot complete, the action is refused.

The full rule set (R1–R17) is in [CLAUDE.md](CLAUDE.md). The specification is in [docs/spec/](docs/spec/).

## Tech stack

| Layer                 | Technology                                                                      |
| --------------------- | ------------------------------------------------------------------------------- |
| Apps                  | Next.js 16, React, next-intl (bn, en), the mockup theme (self-hosted)           |
| Backend               | TypeScript on AWS Lambda, Amazon SQS, Amazon EventBridge                        |
| Data                  | PostgreSQL on Amazon RDS behind RDS Proxy, Drizzle ORM                          |
| Identity              | Amazon Cognito (customers; admins with TOTP MFA and an IP allowlist)            |
| Infrastructure        | SST 4 (Pulumi) in ap-southeast-1, GitHub Actions with OIDC (no long-lived keys) |
| Payments and messages | EPS (BDT), Amazon SES e-mail, Gennet SMS                                        |
| Quality               | Vitest, Playwright, ESLint, Prettier, OmniRank SEO/AEO audit                    |

## Repository layout

```
apps/
  web/             customer panel and public site
  admin/           admin app (separate host, TOTP, IP allowlist)
packages/
  core/            pure logic: pricing, ledger, orders, lifecycle, capacity
  db/              schema, migrations, tenant-scoped repositories
  aws/             AWS clients and product adapters (imported only by functions/)
  eps/ notify/ auth/ ui/
functions/         Lambda handlers: provisioner, scheduler, reconciler, notifier, migrator, ...
infra/             SST app, stacks and the CI role templates (infra/org)
verify/            proofs per task and per gate
docs/runbooks/     operations: go-live, incidents, refunds, KYC, restore drill, ...
```

## Getting started (developers)

Requirements: Node.js 24, pnpm 10 and Docker.

```bash
pnpm install
pnpm db:up && pnpm db:migrate      # local PostgreSQL in Docker
pnpm verify --quick                # lint, typecheck, unit tests of changed packages
pnpm test --filter @tc/core        # one package
pnpm verify --task <task id>       # the proof of one task
```

Rules of the road:

- One task per branch. Plan first. Write tests first for `packages/core`, `db`, `eps` and `aws`.
- Run `pnpm verify --task <id>` before the pull request. A reviewer checks every change; money code goes to the
  money reviewer.
- Never commit secrets. Never deploy production by hand. Production deploys only from a signed-off `v*` tag
  through CI.
- Every task appends an entry to [JOURNEY.md](JOURNEY.md).

## Operations

- **Deploys:** staging runs on demand; production deploys from a `v*` tag (see
  [staging-on-demand](docs/runbooks/staging-on-demand.md) and [go-live](docs/runbooks/go-live.md)).
- **Runbooks:** every operational event (failed provisioning, a stuck payment, a refund, KYC review,
  secret rotation, incidents) has a runbook in [docs/runbooks/](docs/runbooks/README.md).
- **Cost:** production runs lean, at about 80–90 USD a month before customer resources.

## Company

**TryAWS.now** · BIN: 008073062-0507 · Trade License: TRAD/DNCC/098737/2020 · Dhaka, Bangladesh

Amazon Web Services, AWS and Amazon Lightsail are trademarks of Amazon.com, Inc. or its affiliates.
TryAWS.now is an independent reseller and is not affiliated with or endorsed by Amazon.

This is a private, proprietary repository. All rights reserved.
