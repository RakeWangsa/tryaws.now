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

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    // The TypeError of URL holds the whole URL, password included, in its property `input`.
    throw new Error("invalid DATABASE_URL");
  }
}

function withDatabase(url: string, database: string): string {
  const u = parseUrl(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function maintenanceUrl(url: string): string {
  return withDatabase(url, "postgres");
}

const LOCAL_URL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOCAL_DRIVER_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const refuseHost = (host: string) =>
  new Error(
    `refusing to use PostgreSQL at ${host === "" ? "(no host)" : host}: the tests create and drop ` +
      "databases and roles, so they run only against a server on this machine " +
      "(127.0.0.1, localhost or ::1)",
  );

// The tests create and drop databases and create server-wide roles, so they refuse every server that
// is not on this machine. The URL's host is checked first; then the driver is asked which host it
// will use (its own parser takes a `host` query parameter in place of the URL's host). Building a
// client opens no connection. Another port is not refused: it is another server on this machine.
// The message holds the host, never the URL, so it cannot leak the password.
export function assertLocalServer(url: string): void {
  const host = parseUrl(url).hostname;
  if (!LOCAL_URL_HOSTS.has(host)) throw refuseHost(host);
  const driverHost = String(new pg.Client({ connectionString: url }).host ?? "");
  if (!LOCAL_DRIVER_HOSTS.has(driverHost)) throw refuseHost(driverHost);
}

const TEST_DATABASE = /^tc_test_(\d+)_[0-9a-f]{8}$/;

// process.kill(pid, 0) throws ESRCH only when no such process exists. Every other outcome (no error,
// EPERM, an argument error for a number that is no process id) means "not gone": on doubt, keep.
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as { code?: unknown }).code === "ESRCH";
  }
}

// Which of these database names belong to a test run whose process is gone. Pure.
// A name counts only if it is exactly tc_test_<digits>_<8 lower-case hex digits>.
export function leftoverTestDatabases(
  names: readonly string[],
  isGone: (pid: number) => boolean = processIsGone,
): string[] {
  return names.filter((name) => {
    const match = TEST_DATABASE.exec(name);
    return match !== null && isGone(Number(match[1]));
  });
}

// The databases on the server whose name has the form above and that no session is connected to.
export async function unconnectedTestDatabases(admin: pg.Client): Promise<string[]> {
  const { rows } = await admin.query<{ datname: string }>(
    `select d.datname from pg_database d
      where d.datname ~ '^tc_test_[0-9]+_[0-9a-f]{8}$'
        and not exists (select 1 from pg_stat_activity a where a.datid = d.oid)
      order by 1`,
  );
  return rows.map((r) => r.datname);
}

// A database is dropped only when three things hold: the name is the helper's own, exactly; the
// process that made it is gone on this machine; nobody is connected to it. A process id that another
// program reused only leaves a leftover; it never drops a live database. The one case that stays: a
// test run in a container that shares this machine's network but not its process ids looks dead
// here; its database is kept as long as it holds a connection.
// Refuses another host: a process id of another machine would look dead here. Returns the names it
// dropped. A DROP that fails is skipped (another test file may have been faster, or a session may
// have connected in between).
export async function sweepLeftoverTestDatabases(url: string): Promise<string[]> {
  assertLocalServer(url);
  const admin = new pg.Client({
    connectionString: maintenanceUrl(url),
    connectionTimeoutMillis: 5000,
  });
  try {
    await admin.connect();
    const dropped: string[] = [];
    for (const name of leftoverTestDatabases(await unconnectedTestDatabases(admin))) {
      try {
        await admin.query(`DROP DATABASE "${name}"`);
        dropped.push(name);
      } catch {
        // dropped by another sweep, or a session connected in between: keep going
      }
    }
    return dropped;
  } finally {
    await admin.end().catch(() => undefined);
  }
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"]);

type ErrorLike = { code?: unknown; message?: unknown; cause?: { code?: unknown } };

// The code of a network error, or the driver's own message when the error has no code at all.
// An error that carries any other code (a SQLSTATE such as 57014 or 28P01) is not a network error.
function networkReason(err: unknown): string | undefined {
  const e = (err ?? {}) as ErrorLike;
  if (typeof e.code === "string") return NETWORK_CODES.has(e.code) ? e.code : undefined;
  const causeCode = e.cause?.code;
  if (typeof causeCode === "string" && NETWORK_CODES.has(causeCode)) return causeCode;
  const message = typeof e.message === "string" ? e.message : "";
  return /timed? ?out|timeout/i.test(message) ? message : undefined;
}

export function isNetworkError(err: unknown): boolean {
  return networkReason(err) !== undefined;
}

// Only a network error is rewritten; every other error keeps its code and message.
// The text holds host and port, never the URL, so it cannot leak the password.
function explainConnectionError(err: unknown, url: string): unknown {
  const reason = networkReason(err);
  if (reason === undefined) return err;
  const u = parseUrl(url);
  const port = u.port === "" ? "5432" : u.port;
  return new Error(
    `cannot reach PostgreSQL at ${u.hostname}:${port} (${reason}). ` +
      "Start it with pnpm db:up, or set DATABASE_URL.",
    { cause: err },
  );
}

export async function createTempDatabase(
  options: { url?: string; migrate?: boolean } = {},
): Promise<TempDatabase> {
  const baseUrl = options.url ?? databaseUrl();
  const name = `tc_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  const adminUrl = maintenanceUrl(baseUrl); // also refuses a malformed URL
  assertLocalServer(baseUrl); // before any connection is opened
  // A sweep that fails never fails a test: the error of the CREATE DATABASE below is the one that counts.
  await sweepLeftoverTestDatabases(baseUrl).catch(() => undefined);

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
  let poolEnded = false;
  let finished = false;
  let inflight: Promise<void> | undefined;
  const dropOnce = async (): Promise<void> => {
    if (!poolEnded) {
      poolEnded = true;
      await pool.end();
    }
    const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
    try {
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await c.end().catch(() => undefined);
    }
  };
  // A second call while the first runs gets the same promise; after a success it does nothing;
  // after a failure the next call tries again.
  const drop = (): Promise<void> => {
    if (finished) return Promise.resolve();
    inflight ??= dropOnce().then(
      () => {
        finished = true;
      },
      (err: unknown) => {
        inflight = undefined;
        throw err;
      },
    );
    return inflight;
  };

  try {
    if (options.migrate ?? true) await runMigrations(url);
  } catch (err) {
    await drop().catch(() => undefined); // the migration error is the one that counts
    throw err;
  }
  const temp = { name, drop } as TempDatabase;
  // Not enumerable: printing or serialising the object must not print the password.
  // `pool` and `db` hold it too (pg.Pool keeps its connectionString in its options).
  for (const [key, value] of Object.entries({ url, pool, db })) {
    Object.defineProperty(temp, key, { value, enumerable: false });
  }
  return temp;
}

export function useTempDatabase(options: { migrate?: boolean } = {}): TempDatabaseHandle {
  let temp: TempDatabase | undefined;
  beforeAll(async () => {
    // Create and store first, then migrate: afterAll drops the database also when the
    // migration fails or the time limit of this hook fires during it.
    temp = await createTempDatabase({ ...options, migrate: false });
    if (options.migrate ?? true) await runMigrations(temp.url);
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
  const handle = {
    get name() {
      return ready().name;
    },
  } as TempDatabaseHandle;
  // Not enumerable, like the properties of TempDatabase: they hold the password.
  const secret = (key: "url" | "pool" | "db") =>
    Object.defineProperty(handle, key, { get: () => ready()[key], enumerable: false });
  secret("url");
  secret("pool");
  secret("db");
  return handle;
}
