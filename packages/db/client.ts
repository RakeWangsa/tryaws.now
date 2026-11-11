import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// A pool with no connection time-out waits for a free client for ever, so every pool gets one
// (10 seconds); the caller's options win.
export function createDatabase(
  url: string,
  options: pg.PoolConfig = {},
): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000, ...options });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
