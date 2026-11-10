<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "B. What to give Claude Code". Change the plan, then run pnpm spec:split. -->

## B. What to give Claude Code

Claude Code works only with what is on the developer's machine and in the repository. This section is the complete list. Nothing on it is optional unless marked.

### B.1 Files in the repository before the first session

| Item | Where it goes | From |
| --- | --- | --- |
| This file | `TICON_CLOUD_MEGA_PLAN.md` in the repository root | Moshiur |
| The mockup zip, unpacked | `design/mockup/` (the `template`, `order-form`, `whmcs-template`, `email`, `newsletter`, `graphic`, `documentation` folders) | Moshiur |
| TiCON Cloud logo as SVG for dark and light backgrounds, favicon | `design/brand/` | Dev team, from the `ticoncloud` site repo |
| Sample TiCON Cloud invoice (PDF) | `design/reference/invoice-sample.pdf` | Moshiur |
| The team's `eps-payment-gateway` skill folder, copied without any `.env*` file (the skill's README says that `assets/.env.production` holds live credentials of another project) | `.claude/skills/eps-payment-gateway/` | Dev team |
| Legal texts when ready: terms, acceptable use, privacy, refund, domain registration agreement | `content/legal/<doc>.<locale>.mdx` | Moshiur with the legal adviser |

### B.2 Accounts and access

| Access | Scope to give | Scope never to give |
| --- | --- | --- |
| GitHub | One private repository (for example `TiCON-Project/ticoncloud-platform`), `gh` signed in on each developer machine. Branch protection on `main`: pull request required, CI checks required, CODEOWNERS review on money and security paths and on the kit (`.claude/`, `CLAUDE.md`, `.github/`, `scripts/`, `verify/`, `tests/repo/`, `TICON_CLOUD_MEGA_PLAN.md` and the root files `package.json`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `vitest.config.mjs`, `tsconfig.base.json`, `.prettierrc.json`, `.prettierignore`, `.gitleaks.toml`, `.gitignore`, `.worktreeinclude`) | Organization admin rights; permission to push to `main` |
| AWS, staging control plane | An IAM Identity Center permission set on the account `tc-platform-stg` that can deploy the SST app. Used as a named CLI profile, for example `tc-stg` | Any access to `tc-platform` (production), the management account, `tc-pool-v1`, `tc-pool-n1` |
| AWS, test pool | A permission set on `tc-pool-dev` limited to Lightsail, used by integration and isolation tests | Any other pool account |
| AWS, DNS for tests | Permission on `tc-dns` to manage test hosted zones only. Domain registration stays with DevOps | `route53domains:RegisterDomain` from a developer machine |
| Production deploys | None from a machine. Production is deployed by GitHub Actions through an OIDC role after a manual approval | Long-lived AWS keys anywhere (R3) |
| Organization setup (accounts, OUs, SCPs, pool roles) | Claude Code writes the templates in `infra/org/`. DevOps reviews and applies them from the management account | The management account credentials |
| Domain and email | DNS records for `my.`, `ops.` and the staging names; SES domain identity with DKIM for `ticoncloud.com`. Created by the IaC where the zone is in Route 53, otherwise DevOps first validates an ACM certificate in us-east-1 for these names, the apps use `domain: { name, dns: false, cert }`, and DevOps adds CNAME records to the CloudFront domain names after the deploy | Registrar account password |
| EPS | Staging and production credentials as SST secrets (B.3). A test customer account with a small real balance for end-to-end payments | Credentials in a prompt, a file in the repo, or a chat |
| SMS provider | API key as an SST secret, sender id as config, two test phone numbers | Same as EPS |

### B.3 Secrets: set by a person, never shown to Claude Code

A person types these into their own terminal with `npx sst secret set <Name> <value> --stage <stage>` (confirm the syntax in the SST docs). Claude Code knows only the names. Production values are set only by a named administrator of `tc-platform`, because `--stage production` needs credentials for `tc-platform`, which no developer machine may hold (3.1): in a short-lived IAM Identity Center session, from AWS CloudShell or from a machine that runs no Claude Code session, before the first production deploy, noted in `JOURNEY.md` without the values. The project settings deny `sst secret` and `sst shell` commands and reads of `.env` files (Appendix Q). These rules match one spelling of a command and are not a boundary (C.2): anyone, or any session, with the staging profile can read the staging secrets.

| Secret name | Stages | Set by |
| --- | --- | --- |
| `EpsMerchantId`, `EpsStoreId`, `EpsUsername`, `EpsPassword`, `EpsHashKey` | staging, production (separate values) | Moshiur or the lead |
| `SmsApiKey` | staging, production (separate values) | Lead |
| None for pool accounts: each ExternalId is a plain column of `pool_accounts`, so adding a pool needs no secret and no deploy | - | DevOps |

Generated by the infrastructure code, never typed by anyone: the HMAC key for order draft tokens, the OTP hashing key, KMS keys, database passwords.

### B.4 Decisions and values Claude Code needs as config

| Value | Default in this plan | Owner |
| --- | --- | --- |
| Panel and admin domains | `my.ticoncloud.com`, `ops.ticoncloud.com`; staging `my-stg.` and `ops-stg.` | Moshiur |
| FX rate for market BD | 127 as the test value. The real rate is set by a `finance` admin before beta | Moshiur |
| Top-up minimum, maximum and quick amounts | Open (Section 17) | Moshiur |
| Launch Regions | Singapore `ap-southeast-1`, Mumbai `ap-south-1` | Decided |
| Pool account ids and real quotas | Entered in `pool_accounts` and `pool_capacity` by DevOps | DevOps |
| Admin IP allowlist, on-call list | Open (Section 17) | Moshiur |
| Support phone, support email, sender names | Open (Section 17) | Moshiur |
| Company details on invoices | Name and address from Section 1; BIN and other registration numbers from the sample invoice | Moshiur |
| Color scheme, numerals | Mockup colors; Bengali numerals (Section 17) | Moshiur |

### B.5 Tools on each developer machine

| Tool | Note |
| --- | --- |
| Claude Code, current version | Auto mode is the starting permission mode from v2.1.283. Check with `claude --version` |
| Node.js | Node.js 24, the Lambda runtime `nodejs24.x` and the SST default; Node.js 26 is only a preview runtime on Lambda this month. Pin it in `.nvmrc` and `package.json` `engines` |
| pnpm, Git, GitHub CLI `gh`, `jq` | `jq` is used by the hook scripts |
| AWS CLI v2 | Signed in through IAM Identity Center with the profiles of B.2 |
| Docker | Runs the PostgreSQL container for integration tests |
| Playwright browsers | Installed by the repo's setup script |

### B.6 People Claude Code depends on

| Need | Who | Response time during the sprint |
| --- | --- | --- |
| "Needs decision" items in `JOURNEY.md` | Moshiur | Twice a day, 10:00 and 21:00 |
| Review of pull requests that touch money, auth, IAM or infrastructure | Lead developer | Within 2 working hours |
| AWS organization changes, quotas, DNS | DevOps | Same day |
| KYC review, support, abuse during beta and launch | Operations lead | Section M |

### B.7 What Claude Code must never receive

Production or management account credentials. Real customer data, KYC documents or a production database dump. EPS or SMS credentials in any readable form. A session started with `--dangerously-skip-permissions` or in `bypassPermissions` mode on a machine that holds AWS credentials. The theme files in a public repository.

