// @tc/db/testing: the test helpers of @tc/db for the test files of other packages (WP1-T2).
// Only test code imports this entry; tests/repo/testing-entry.test.mjs enforces that.
export {
  useTempDatabase,
  createTempDatabase,
  type TempDatabase,
  type TempDatabaseHandle,
} from "../test/temp-db";
export { type Queryable, insertRow, inTransaction } from "../test/sql";
export { uniqueSuffix, ensureMarket, newAdmin, newCustomer, newResource } from "../test/fixtures";
export { useBoundTestDatabase } from "./bind";
export { runTransaction, bindDatabase, attachErrorListeners, type DatabaseRole } from "../tx";
