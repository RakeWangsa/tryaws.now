<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 777-804. Change the plan, then run pnpm spec:split. -->

## 5. Repository layout

```
apps/
  web/            customer panel and public pages (Next.js); public/theme/ is generated
  admin/          admin panel (Next.js); public/theme/ is generated
packages/
  core/           pricing, ledger, lifecycle, capacity, policies (pure logic, no AWS, no HTTP)
  db/             Drizzle schema, migrations, repositories (tenant-scoped)
  aws/            Lightsail, Route 53 and STS clients and product adapters (imported only by functions/)
  eps/            EPS client and payment state machine
  notify/         email and SMS providers and templates
  auth/           Cognito token verification and session helpers
  ui/             theme files, tokens, shells and components shared by web and admin (Section 16)
functions/
  provisioner/  reader/  access-details/  scheduler/  payments-sweeper/
  catalog-sync/  reconciler/  migrator/  invoice-renderer/
infra/            SST definitions (one file per concern); infra/org/ holds the Organization templates that DevOps applies
tests/            e2e and isolation tests
design/           mockup/ (the mockup zip contents: read-only reference, excluded from every build), brand/ (logo, favicon), reference/ (sample invoice)
scripts/          sync-theme.ts (Section 16.3), split-plan.mjs and verify.mjs (Section G)
verify/           baseline.json and the gate checks (Section G)
content/          legal pages, FAQ and help articles as MDX
docs/spec/        generated from the mega plan, one file per section; docs/runbooks/ for operations
.claude/          settings, hooks, rules, skills and subagents (Appendices Q to S)
CLAUDE.md  JOURNEY.md  TICON_CLOUD_MEGA_PLAN.md
```

