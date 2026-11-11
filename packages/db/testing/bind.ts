import { afterAll, beforeAll } from "vitest";
import { useTempDatabase, type TempDatabaseHandle } from "../test/temp-db";
import { bindDatabase, type DatabaseRole } from "../tx";

// A temporary database that withTx uses for the whole test file, as `role`. Vitest runs beforeAll
// hooks in registration order and afterAll hooks in reverse, so the binding starts after the
// database exists and ends before it is dropped. Call it once at the top level of a test file,
// instead of useTempDatabase().
export function useBoundTestDatabase(role: DatabaseRole = "web_rw"): TempDatabaseHandle {
  const t = useTempDatabase();
  beforeAll(() => bindDatabase({ db: t.db, role }));
  afterAll(() => bindDatabase(null));
  return t;
}
