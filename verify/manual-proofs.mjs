// The catalogue of the items that only a person or AWS can prove (gates M1 to M7). Each id is a check
// `node scripts/manual-proof.mjs <id>` in verify/checks.mjs. It fails (BLOCKED, exit 2) until a person adds
// a record {evidence, recordedBy, recordedAt} for the id to verify/manual-proofs.json (which starts as {}).
// `evidence` says what was seen and where it is written down (JOURNEY.md entry, run URL, ticket); it never
// holds a secret, a key, an account id or a document number (R3, R14).
// gate: the first gate that needs the proof. task: the backlog row (docs/spec/E-backlog-and-prompts.md) or
// the line of Section G / K / 15. who: the role that records it.
export const MANUAL_PROOFS = {
  "wp0-t2-staging-deploy": {
    gate: "M1",
    task: "WP0-T2",
    who: "DevOps",
    description:
      "`npx sst deploy --stage staging` succeeded; the hello page loads through CloudFront; a direct request to the function URL gets 403",
  },
  "wp0-t3-staging-database": {
    gate: "M1",
    task: "WP0-T3",
    who: "DevOps",
    description:
      "on staging: a connection from the internet fails; a connection without TLS through the proxy is refused; the instance shows 1-day backup retention, no deletion protection and no final snapshot (WPU-Z10: staging runs only during test sessions and its data is wiped at each sst remove), while production keeps 14-day (7 lean) retention, deletion protection and its final snapshot; the migrator ran an empty migration",
  },
  "wp0-t4-staging-outputs": {
    gate: "M1",
    task: "WP0-T4",
    who: "DevOps",
    description:
      "the deployed outputs of staging are listed: both Cognito pools (admin TOTP required), the FIFO queue with its dead-letter queue, the buckets kyc, invoices and exports, the alarms to SNS",
  },
  "wp0-t5-devops-confirmation": {
    gate: "M1",
    task: "WP0-T5",
    who: "DevOps",
    description:
      "DevOps applied infra/org (accounts, OUs, SCPs, roles, trail, GuardDuty, security contacts) and confirms it in JOURNEY.md; a test showed that the staging web role cannot assume TcProvisioner",
  },
  "m1-staging-signup-catalog": {
    gate: "M1",
    task: "Section G, gate M1",
    who: "Lead developer",
    description:
      "on staging a new customer signs up through KYC submission, and a signed-in customer sees the real catalog in taka",
  },
  "wp3-t4-staging-topup": {
    gate: "M2",
    task: "WP3-T4",
    who: "Lead developer",
    description:
      "a real EPS top-up on staging credits the wallet exactly once and shows the new balance; the replay and forgery tests pass on staging",
  },
  "wp4-t5-staging-ssh": {
    gate: "M2",
    task: "WP4-T5",
    who: "Lead developer",
    description:
      "a paid order on staging yields a running instance in tc-pool-dev that is reachable by SSH with the customer's key",
  },
  "m2-ui-review": {
    gate: "M2",
    task: "Section G, gate M2",
    who: "Moshiur",
    description: "the UI review of Thursday evening was done with Moshiur",
  },
  "wp4-t6-isolation-pool-dev": {
    gate: "M3",
    task: "WP4-T6",
    who: "Lead developer",
    description:
      "tests/isolation passes in tc-pool-dev (a customer's server cannot reach another customer's server over the private network)",
  },
  "wp4-t7-staging-playwright": {
    gate: "M3",
    task: "WP4-T7",
    who: "Lead developer",
    description: "Playwright creates a server at 360 px in bn against staging",
  },
  "m3-staging-notifications": {
    gate: "M3",
    task: "Section G, gate M3",
    who: "Lead developer",
    description:
      "on staging the notifications send: every trigger of 16.14 produced one message, with no secret in it",
  },
  "wp0-t6-production-tag-deploy": {
    gate: "M3",
    task: "WP0-T6",
    who: "DevOps",
    description:
      "a version-tag deploy of the production control plane (every feature flag off) succeeded after DevOps approval, and the production web role cannot assume any pool role",
  },
  "m4-gate-a-staging-cycles": {
    gate: "M4",
    task: "Section G, gate M4",
    who: "Lead developer",
    description:
      "the Gate A adapters (Windows, database, load balancer, object storage) pass their create to destroy cycles on staging",
  },
  "m4-public-pages-staging": {
    gate: "M4",
    task: "Section G, gate M4",
    who: "Lead developer",
    description: "the public P0 pages are live on staging",
  },
  "m5-gate-b-staging-cycles": {
    gate: "M5",
    task: "Section G, gate M5",
    who: "Lead developer",
    description:
      "the Gate B adapters (container service, CDN, DNS, domains) pass their cycles on staging",
  },
  "m5-reconciler-staging": {
    gate: "M5",
    task: "WP7-T5, WP7-T6",
    who: "DevOps",
    description:
      "metering ran; the reconciler reports zero unexplained resources and a cost variance under 2% on the latest day Cost Explorer has data for",
  },
  "wp9-t1-section15-evidence": {
    gate: "M6",
    task: "WP9-T1",
    who: "Lead developer",
    description: "every item of Section 15 has evidence in JOURNEY.md (name the entry)",
  },
  "wp9-go-no-go-list": {
    gate: "M6",
    task: "Section K",
    who: "Moshiur",
    description:
      "the go/no-go list of Section K is full: all twelve items are true, each with its evidence",
  },
  "wp9-t3-pitr-restore": {
    gate: "M6",
    task: "WP9-T3",
    who: "DevOps",
    description:
      "the point-in-time restore of the platform database on RDS worked (docs/runbooks/restore-drill.md); the restored copy holds the ledger invariants",
  },
  "wp9-t4-runbooks-walked": {
    gate: "M6",
    task: "WP9-T4",
    who: "Lead developer",
    description: "each runbook of Section M in docs/runbooks/ was walked through once",
  },
  "wp9-t5-legal-final": {
    gate: "M6",
    task: "WP9-T5",
    who: "Moshiur",
    description:
      "the final legal content (terms, acceptable use, privacy, refund) is approved and published, and the bn text was read by a native speaker",
  },
  "wp9-t6-production-tag-deploy": {
    gate: "M6",
    task: "WP9-T6",
    who: "DevOps",
    description:
      "the production tag deploy of the build that passed gate M5 succeeded, approved by DevOps",
  },
  "wp9-t6-beta-payments": {
    gate: "M6",
    task: "WP9-T6",
    who: "Moshiur",
    description:
      "each of the 10 to 20 beta customers has a verified payment and a running server on production with the core flags on",
  },
  "wp10-t1-flags-as-decided": {
    gate: "M7",
    task: "WP10-T1",
    who: "Moshiur",
    description:
      "the feature flags are set as decided: on only for the families that passed their gate",
  },
  "wp10-t1-alarms-deliver": {
    gate: "M7",
    task: "WP10-T1",
    who: "DevOps",
    description: "a test alarm reached the alarm e-mail addresses",
  },
  "wp10-t1-on-call-confirmed": {
    gate: "M7",
    task: "WP10-T1",
    who: "Moshiur",
    description:
      "the on-call list is final and confirmed; support is the in-app request system (no support phone and no support e-mail, owner decision 2026-11-13)",
  },
  "wp10-t2-first-day-report": {
    gate: "M7",
    task: "WP10-T2",
    who: "Lead developer",
    description:
      "the first-day report of 21:00 was produced: payments verified, no stuck operations, no dead-letter messages, active resources counted",
  },
};
