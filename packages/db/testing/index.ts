// @tc/db/testing: the test helpers of @tc/db for the test files of other packages (WP1-T2).
// Only test code imports this entry; tests/repo/testing-entry.test.mjs enforces that.
export {
  useTempDatabase,
  createTempDatabase,
  type TempDatabase,
  type TempDatabaseHandle,
} from "../test/temp-db";
export { type Queryable, insertRow, inTransaction } from "../test/sql";
export {
  uniqueSuffix,
  ensureMarket,
  newAdmin,
  newCustomer,
  newResource,
  newOrder,
} from "../test/fixtures";
export { useBoundTestDatabase } from "./bind";
export { runTransaction, bindDatabase, attachErrorListeners, type DatabaseRole } from "../tx";
export { tenantSnapshot } from "./snapshot";
export { TENANT_TABLES, NON_TENANT_TABLES } from "../tenancy";
export {
  checkTenantIsolation,
  expectTenantIsolation,
  ghostOf,
  type TenantCase,
  type TenantCheck,
  type TenantFinding,
  type TenantIsolationOptions,
} from "./cross-tenant";
export { unscopedStatements, type RecordedStatement } from "./sql-audit";
export { statementsWithInlinedIds } from "./sql-audit";
// For tests only; production reaches these through adminRepos(...).operations (R10).
export {
  approveOperation,
  retryOperation,
  rejectOperation,
  type AdminMessage,
  type AdminOutcome,
} from "../operations/admin";
export { withCustomerRepos } from "./repos";
export { auditRowsOf, type AuditRow } from "./repos";
export {
  holdUntilWaiter,
  seedPool,
  readUsed,
  resetCapacity,
  type PoolSeed,
  type SeededPool,
} from "./capacity";
