// WPU-B4 (audit item 31): where each item of Section 15 (docs/spec/15) is proved locally, and what only a
// person or AWS can prove. Section 15 is generated from the plan and never edited here; this map names, for
// every item, the test files that prove the local half and the manual proof (verify/manual-proofs.mjs) that
// holds the other half. tests/repo/section15-local.test.mjs reads the spec, checks that every item has an
// entry (so a changed or added item stops the build until it is mapped) and that every file exists.
// The evidence of WP9-T1 stays a manual proof: "wp9-t1-section15-evidence".
export const SECTION15 = [
  {
    start: "Web and admin function roles have no `sts:AssumeRole`",
    local: ["tests/repo/infra-rules.test.mjs", "tests/repo/infra-org.test.mjs"],
    manual: ["wp0-t5-devops-confirmation"],
  },
  {
    start: "RDS has no public endpoint",
    local: ["tests/repo/infra-rules.test.mjs"],
    manual: ["wp0-t3-staging-database"],
  },
  {
    start: "No secret in the repo history or client bundles",
    local: ["tests/repo/ci-workflow.test.mjs", "packages/eps/test/proof-secrets.test.ts"],
    manual: ["wp9-t1-section15-evidence"],
  },
  {
    start: "Every customer endpoint has a passing cross-tenant test",
    local: ["apps/web/server/endpoint-sweep.test.ts", "packages/db/test/cross-tenant.test.ts"],
  },
  {
    start: "EPS: replay, forged redirect, amount mismatch and double callback tests pass",
    local: [
      "packages/eps/test/verify-race.test.ts",
      "packages/eps/test/proof-parallel-credit.test.ts",
      "packages/eps/test/returns.test.ts",
      "packages/db/test/payments-system.test.ts",
    ],
    manual: ["wp3-t4-staging-topup"],
  },
  {
    start: "Ledger: balance check job reports zero differences",
    local: ["packages/core/ledger/check.test.ts", "packages/db/test/ledger-audit.test.ts"],
    manual: ["wp9-t1-section15-evidence"],
  },
  {
    start: "Rate limits active on sign-in, OTP, top-up and order endpoints",
    local: ["packages/db/test/rate-limit.test.ts", "tests/repo/infra-rules.test.mjs"],
    manual: ["wp9-t1-section15-evidence"],
  },
  {
    start: "Security headers: CSP with nonces, HSTS",
    local: [
      "apps/web/proxy.test.ts",
      "apps/admin/proxy.test.ts",
      "packages/ui/runtime/csp.test.ts",
      "tests/repo/infra-rules.test.mjs",
    ],
  },
  {
    start: "Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`",
    local: ["packages/auth/test/cookies.test.ts", "apps/web/server/request.test.ts"],
  },
  {
    start: "Uploads: size and type limits enforced by the presigned policy",
    local: ["apps/web/server/kyc-actions.test.ts", "tests/repo/infra-rules.test.mjs"],
  },
  {
    start: "Admin: separate pool, MFA required, IP allowlist enforced",
    local: ["apps/admin/proxy.test.ts", "tests/repo/infra-rules.test.mjs"],
    manual: ["wp0-t2-staging-deploy"],
  },
  {
    start: "Isolation test passes in each launch Region",
    local: ["tests/isolation/plan.test.ts"],
    manual: ["wp4-t6-isolation-pool-dev"],
  },
  {
    start: "SCPs attached to the pool OU and `tc-dns`",
    local: ["tests/repo/infra-org.test.mjs"],
    manual: ["wp0-t5-devops-confirmation"],
  },
  {
    start: "CloudTrail and GuardDuty on in every account",
    local: ["tests/repo/infra-org.test.mjs", "tests/repo/infra-rules.test.mjs"],
    manual: ["wp0-t5-devops-confirmation"],
  },
  {
    start: "Database restore from a point-in-time backup tested once",
    local: ["scripts/lib/restore-drill.test.mjs"],
    manual: ["wp9-t3-pitr-restore"],
  },
  {
    start: "`pnpm audit` shows no high or critical issue",
    local: ["tests/repo/ci-workflow.test.mjs"],
  },
  {
    start: "Each pool account has a monitored security alternate contact",
    local: ["tests/repo/infra-org.test.mjs"],
    manual: ["wp9-t4-runbooks-walked"],
  },
  {
    start: "No page requests a third-party origin",
    local: [
      "packages/ui/theme/tc-fonts.test.ts",
      "apps/web/app/[locale]/(public)/public-pages.test.tsx",
    ],
  },
  {
    start: "No file from the mockup's `assets/js`",
    local: ["packages/ui/theme/scan-output.test.ts", "tests/repo/ignored-files.test.mjs"],
  },
  {
    start: "No page, API response, email or SMS that a customer can see contains an AWS account id",
    local: ["apps/web/messages.test.ts", "apps/admin/messages.test.ts"],
  },
  {
    start: "No developer machine and no Claude Code session holds credentials",
    local: ["tests/repo/ci-deploy.test.mjs"],
    manual: ["wp9-t6-production-tag-deploy"],
  },
  {
    start: "Shell and template characters in every free-text field reach no AWS name",
    local: ["packages/core/naming/naming.test.ts", "packages/aws/test/bootstrap.test.ts"],
  },
  {
    start: "With EPS verify, the KYC lookup or capacity stubbed to fail, the action is refused",
    local: ["packages/eps/test/verify.test.ts", "packages/core/orders/gates.test.ts"],
  },
  {
    start: "An absolute or `//` value of `next` is ignored",
    local: ["apps/web/server/request.test.ts", "packages/core/orders/gates.test.ts"],
  },
];
