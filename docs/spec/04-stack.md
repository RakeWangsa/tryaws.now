<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 749-776. Change the plan, then run pnpm spec:split. -->

## 4. Stack

| Layer | Choice | Why (security first) |
| --- | --- | --- |
| Language | TypeScript, strict mode | One language end to end; types on money and ids |
| Web framework | Next.js 15 or newer stable, App Router, Server Actions and Route Handlers | Server-side rendering keeps secrets and logic off the client |
| Infrastructure as code | SST v3 (OpenNext on Lambda, `sst.aws.Vpc`, `sst.aws.Postgres` with proxy, `sst.aws.Nextjs` with `vpc`, `sst.aws.Queue`, `sst.aws.Cron`, `sst.aws.Bucket`, `sst.Secret`) | No servers to patch; one IAM role per function gives real privilege separation |
| Database | Amazon RDS for PostgreSQL 16 or newer, private, behind RDS Proxy | Financial ledger and KYC data stay inside TiCON's own AWS account and off the internet |
| ORM and migrations | Drizzle ORM with `pg`, drizzle-kit migrations | Typed SQL, explicit transactions and row locks |
| Authentication | Amazon Cognito: one user pool for customers, a separate pool for admins | Passwords are never stored in our database; managed MFA and lockout |
| Validation | zod on every input | Rule R9 |
| Queue and schedule | SQS FIFO, EventBridge | Durable, ordered per resource, no public surface |
| AWS access | AWS SDK for JavaScript v3 (`@aws-sdk/client-lightsail`, `@aws-sdk/client-route-53`, `@aws-sdk/client-route-53-domains`, `@aws-sdk/client-sts`, `@aws-sdk/client-cost-explorer`; confirm the names at install), used only inside `packages/aws` with temporary credentials from STS AssumeRole. The SDK calls the Lightsail API (version 2016-11-28) | The SDK signs requests, retries throttled calls and types every action. No hand-written HTTP calls to AWS, no AWS CLI, and no CloudFormation for customer resources |
| Payments | EPS hosted checkout through the team's `eps-payment-gateway` skill (Next.js client) | No card data touches the platform |
| Email | Amazon SES with DKIM for `ticoncloud.com` | |
| SMS | Provider adapter (`SmsProvider` interface); provider chosen by the team | OTP codes are hashed at rest |
| Money math | `decimal.js` or `big.js` inside `packages/core/pricing` only | Rule R4 |
| Tests | Vitest (unit and integration against a Postgres container), Playwright (critical flows) | Rule R15 |
| i18n | `next-intl`, `bn` default | |
| CI and deploy | GitHub Actions. Staging deploys on merge through an OIDC role in `tc-platform-stg`. Production deploys from a tag through an OIDC role in `tc-platform` after a manual approval | No deploy key exists anywhere (R3) |
| Invoice PDF | The invoice HTML rendered by headless Chromium in `invoice-renderer` | Bengali text needs real text shaping |
| UI | Bootstrap 5.2.3 CSS and the Antler theme CSS from the mockup, rendered by React Server Components (Section 16). No jQuery and no theme JavaScript | Small script surface, so a strict CSP with nonces works |
| UI behavior | Radix UI primitives (dialog, dropdown menu, tabs, accordion, toast, tooltip) carrying the theme's classes | Keyboard and focus handling without the theme's scripts |
| Charts | Recharts, rendered on the client only | SVG output, no `eval` |
| Fonts and icons | Self-hosted Open Sans and Noto Sans Bengali; Font Awesome Free 6.4.2 and the theme's line icon fonts | No third-party origin at runtime |

Differences from the usual TiCON default stack, and why: RDS inside a VPC instead of an external serverless Postgres, Lambda inside the VPC with NAT, and Cognito instead of a library-managed password store. Each trade costs some money and setup time and removes an internet-facing path to money or identity data.

