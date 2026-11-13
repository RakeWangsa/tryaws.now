// WPU-Z10: pure rules of the database stack (infra/stacks/database.ts), tested by
// tests/repo/staging-on-demand.test.mjs. No SST global is used here.

export interface DbParameter {
  readonly name: string;
  readonly value: string;
  readonly applyMethod?: string;
}

const FORCE_SSL = "rds.force_ssl";

// TLS forced on the instance (3.3, R2) by exactly one rds.force_ssl entry with value 1.
// VERIFY review 2026-11-13 (docs/analysis/verify-review-2026-11-13.md, B1 infra/stacks/database.ts:63,
// lines 120 to 130): SST 4.17.2 postgres.ts createParameterGroup already sets rds.force_ssl to 0, and the
// transform appended a second entry with 1. The provider keeps both (a set hashed on name, apply method
// and value) and reads back one value per name, so the group held 0 and 1 and never matched its state.
// This REPLACES every rds.force_ssl entry and keeps the other parameters (rds.logical_replication).
// applyMethod "immediate": RDS allows it for dynamic parameters only ("pending-reboot" is valid for
// both); the group is attached when the instance is created, so either works on the first deploy.
// VERIFY on the first deploy: a connection without TLS is refused (manual proof wp0-t3-staging-database).
export function withForcedTls(parameters: readonly DbParameter[]): DbParameter[] {
  return [
    ...parameters.filter((parameter) => parameter.name !== FORCE_SSL),
    { name: FORCE_SSL, value: "1", applyMethod: "immediate" },
  ];
}
