import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { createDatabase, type Database } from "../client";
import { databaseUrl } from "../env";
import { runMigrations } from "../migrate";

export interface TempDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  db: Database;
  drop(): Promise<void>;
}

export type TempDatabaseHandle = {
  readonly name: string;
  readonly url: string;
  readonly pool: pg.Pool;
  readonly db: Database;
};

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function maintenanceUrl(url: string): string {
  return withDatabase(url, "postgres");
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"]);

// Only a network error is rewritten; every other error keeps its code and message.
// The text holds host and port, never the URL, so it cannot leak the password.
function explainConnectionError(err: unknown, url: string): unknown {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = [e?.code, e?.cause?.code].find((c) => c !== undefined && NETWORK_CODES.has(c));
  const timedOut = /timed? ?out|timeout/i.test(e?.message ?? "");
  if (code === undefined && !timedOut) return err;
  const u = new URL(url);
  const port = u.port === "" ? "5432" : u.port;
  return new Error(
    `cannot reach PostgreSQL at ${u.hostname}:${port} (${code ?? e.message}). ` +
      "Start it with pnpm db:up, or set DATABASE_URL.",
    { cause: err },
  );
}

export async function createTempDatabase(
  options: { url?: string; migrate?: boolean } = {},
): Promise<TempDatabase> {
  const baseUrl = options.url ?? databaseUrl();
  const name = `tc_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  const adminUrl = maintenanceUrl(baseUrl);

  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  } catch (err) {
    throw explainConnectionError(err, baseUrl);
  } finally {
    await admin.end().catch(() => undefined);
  }

  const url = withDatabase(baseUrl, name);
  const { db, pool } = createDatabase(url);
  let dropped = false;
  const drop = async (): Promise<void> => {
    if (dropped) return;
    dropped = true;
    await pool.end();
    const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };

  try {
    if (options.migrate ?? true) await runMigrations(url);
  } catch (err) {
    await drop();
    throw err;
  }
  return { name, url, pool, db, drop };
}

export function useTempDatabase(options: { migrate?: boolean } = {}): TempDatabaseHandle {
  let temp: TempDatabase | undefined;
  beforeAll(async () => {
    temp = await createTempDatabase(options);
  }, 60_000);
  afterAll(async () => {
    if (temp) await temp.drop();
  }, 60_000);
  const ready = (): TempDatabase => {
    if (!temp) {
      throw new Error(
        "useTempDatabase: the database is not ready; read it inside a hook or a test",
      );
    }
    return temp;
  };
  return {
    get name() {
      return ready().name;
    },
    get url() {
      return ready().url;
    },
    get pool() {
      return ready().pool;
    },
    get db() {
      return ready().db;
    },
  };
}
