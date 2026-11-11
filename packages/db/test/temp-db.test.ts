import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { databaseUrl } from "../env";
import {
  assertLocalServer,
  createTempDatabase,
  isNetworkError,
  leftoverTestDatabases,
  maintenanceUrl,
  sweepLeftoverTestDatabases,
  unconnectedTestDatabases,
  type TempDatabase,
} from "./temp-db";

async function databaseExists(...names: string[]): Promise<number> {
  const url = maintenanceUrl(databaseUrl());
  assertLocalServer(url); // the very string this client connects with
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = any($1)", [
      names,
    ]);
    return rowCount ?? 0;
  } finally {
    await admin.end();
  }
}

it("maps any URL to the maintenance database of the same server", () => {
  expect(maintenanceUrl("postgres://u:p@db.local:6543/ticoncloud?sslmode=require")).toBe(
    "postgres://u:p@db.local:6543/postgres?sslmode=require",
  );
});

it("creates, uses and drops a database with a unique name", async () => {
  let a: TempDatabase | undefined;
  let b: TempDatabase | undefined;
  try {
    a = await createTempDatabase({ migrate: false });
    b = await createTempDatabase({ migrate: false });
    expect(a.name).toMatch(/^tc_test_\d+_[0-9a-f]{8}$/);
    expect(a.name).not.toBe(b.name);
    const { rows } = await a.pool.query(
      "select current_database() as db, current_setting('server_version_num')::int as v",
    );
    expect(rows[0].db).toBe(a.name);
    expect(rows[0].v).toBeGreaterThanOrEqual(160000);
  } finally {
    await Promise.allSettled([a?.drop(), b?.drop()]);
  }
  expect(await databaseExists(a!.name, b!.name)).toBe(0);
}, 60_000);

it("drop() shares a running call, is a no-op afterwards and leaves the database gone", async () => {
  const a = await createTempDatabase({ migrate: false });
  try {
    const first = a.drop();
    const second = a.drop();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await a.drop();
    expect(await databaseExists(a.name)).toBe(0);
  } finally {
    await a.drop().catch(() => undefined);
  }
}, 60_000);

it("fails with a clear message, without the password, when the server cannot be reached", async () => {
  for (const host of ["127.0.0.1", "localhost"]) {
    const err = await createTempDatabase({
      url: `postgres://postgres:secret-pw@${host}:1/ticoncloud`,
      migrate: false,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(
      new RegExp(`^cannot reach PostgreSQL at ${host.replace(/\./g, "\\.")}:1 \\(ECONNREFUSED\\)`),
    );
    expect(err!.message).toMatch(/pnpm db:up|DATABASE_URL/);
    expect(err!.message).not.toContain("secret-pw");
  }
}, 30_000);

// This test needs a server that checks passwords (scram or md5). With trust authentication
// the wrong password is accepted; the test then fails and says so.
it("does not call a refused password 'cannot reach'", async () => {
  const u = new URL(databaseUrl());
  u.password = "wrong-" + u.password;
  let accepted: TempDatabase | undefined;
  let err: (Error & { code?: string }) | undefined;
  try {
    accepted = await createTempDatabase({ url: u.toString(), migrate: false });
  } catch (e) {
    err = e as Error & { code?: string };
  } finally {
    if (accepted) await accepted.drop();
  }
  if (accepted) {
    throw new Error(
      "the server accepted a wrong password (trust authentication?); this test needs password authentication",
    );
  }
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).not.toMatch(/^cannot reach/);
  expect(err!.code).toBe("28P01");
}, 30_000);

it("decides what a network error is by code, and by message only when there is no code", () => {
  expect(
    isNetworkError({ code: "57014", message: "canceling statement due to statement timeout" }),
  ).toBe(false);
  expect(isNetworkError(new Error("Connection terminated due to connection timeout"))).toBe(true);
  expect(isNetworkError({ code: "ECONNREFUSED" })).toBe(true);
  expect(isNetworkError({ cause: { code: "ETIMEDOUT" } })).toBe(true);
  expect(isNetworkError({ code: "28P01", message: "password authentication failed" })).toBe(false);
});

it("hides the password of a malformed URL and of a real one", async () => {
  const err = await createTempDatabase({ url: "postgres://u:secret-pw@", migrate: false }).then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toBe("invalid DATABASE_URL");
  expect(Object.getOwnPropertyNames(err!).sort()).toEqual(["message", "stack"]);
  expect(JSON.stringify(err) + Object.getOwnPropertyNames(err!).join()).not.toContain("secret-pw");

  const a = await createTempDatabase({ migrate: false });
  try {
    const password = new URL(databaseUrl()).password;
    expect(JSON.stringify(a)).not.toContain(password);
    expect(Object.keys(a)).not.toContain("url");
    expect(a.url).toContain(a.name);
  } finally {
    await a.drop();
  }
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Only a server on this machine

const REFUSAL = /^refusing to use PostgreSQL at /;
const ANY_REFUSAL = /^refusing to use /;

// The driver's parser and URL disagree on these: after re-serialising, the maintenance URL goes to
// another host than the one the driver reads from the URL as given.
const PARSER_GAPS = [
  "postgres://u:secret-pw@localhost/x?h%6fst=db.example.test&a=b c",
  "postgres://u:secret-pw@localhost/x?h%6Fst=10.0.0.5&p%6Frt=6543&a=b c",
  "postgres://u:secret-pw@localhost/x b?h%6fst=db.example.test",
];

function refusal(fn: () => void): Error | undefined {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  return undefined;
}

it("assertLocalServer accepts 127.0.0.1, localhost and ::1 on any port", () => {
  for (const url of [
    "postgres://u:p@127.0.0.1:5432/x",
    "postgres://u:p@localhost/x",
    "postgres://u:p@[::1]:5432/x",
    // another port is another server on this machine
    "postgres://u:p@localhost:6543/x",
  ]) {
    expect(() => assertLocalServer(url)).not.toThrow();
  }
});

it("assertLocalServer refuses every other host and never prints the password", () => {
  const urls = [
    "postgres://u:secret-pw@db.example.test/x",
    "postgres://u:secret-pw@10.0.0.5/x",
    "postgres://u:secret-pw@127.0.0.2/x",
    "postgres://u:secret-pw@localhost.example.test/x",
    "postgres://u:secret-pw@LOCALHOST/x",
  ];
  for (const url of urls) {
    const err = refusal(() => assertLocalServer(url));
    expect({ url, refused: err instanceof Error }).toEqual({ url, refused: true });
    expect(err!.message).toMatch(REFUSAL);
    expect(err!.message).not.toContain("secret-pw");
  }
  expect(refusal(() => assertLocalServer("postgres:///x"))?.message).toMatch(
    /^refusing to use PostgreSQL at \(no host\): /,
  );
});

it("assertLocalServer refuses a URL with query parameters or a fragment, naming no part of it", () => {
  const urls = [
    ...PARSER_GAPS,
    "postgres://u:secret-pw@localhost/x?host=db.example.test",
    "postgres://u:secret-pw@localhost/x?port=5433",
    "postgres://u:secret-pw@localhost/x?application_name=tests",
    "postgres://u:secret-pw@localhost/x?hostaddr=10.0.0.5",
    "postgres://u:secret-pw@localhost/x#frag",
    // the driver's parser would read this file or refuse this value: it never gets the string
    "postgres://u:secret-pw@localhost/x?sslcert=/nonexistent/example.crt",
    "postgres://u:secret-pw@localhost/x?sslnegotiation=example",
  ];
  for (const url of urls) {
    const err = refusal(() => assertLocalServer(url));
    expect({ url, refused: err instanceof Error }).toEqual({ url, refused: true });
    expect({ url, message: err!.message }).toEqual({
      url,
      message:
        "refusing to use this DATABASE_URL: a URL for the tests may not carry query parameters or a fragment",
    });
    expect(err!.message).toMatch(ANY_REFUSAL);
    expect(err!.message).not.toContain("secret-pw");
    expect(err!.message).not.toContain("example");
  }
});

it("createTempDatabase refuses another host before it opens a connection", async () => {
  const err = await createTempDatabase({
    url: "postgres://u:secret-pw@db.example.test:5432/x",
    migrate: false,
  }).then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toMatch(REFUSAL);
  expect(err!.message).toContain("db.example.test");
  expect(err!.message).not.toContain("secret-pw");
});

it("createTempDatabase and the sweep refuse the URLs on which the two parsers disagree", async () => {
  for (const url of PARSER_GAPS) {
    for (const attempt of [
      () => createTempDatabase({ url, migrate: false }),
      () => sweepLeftoverTestDatabases(url),
    ]) {
      const err = await attempt().then(
        () => null,
        (e: Error) => e,
      );
      expect({ url, refused: err instanceof Error }).toEqual({ url, refused: true });
      expect(err!.message).toMatch(ANY_REFUSAL);
      expect(err!.message).not.toContain("secret-pw");
      expect(err!.message).not.toContain("example");
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The databases of dead test runs

function exitedPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (pid === undefined) throw new Error("spawnSync gave no process id");
  return pid;
}

async function withMaintenance<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const url = maintenanceUrl(databaseUrl());
  assertLocalServer(url); // the very string this client connects with
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

it("leftoverTestDatabases takes only the helper's exact names of a gone process", () => {
  const names = [
    "tc_test_123_deadbeef",
    "tc_test_124_deadbeef",
    "tc_test_123_DEADBEEF",
    "tc_test_123_deadbee",
    "tc_test_123_deadbeef0",
    "tc_tests_123_deadbeef",
    "xtc_test_123_deadbeef",
    "tc_test__deadbeef",
    "tc_test_12a_deadbeef",
    "tc_test_123_deadbeef\n",
    "ticoncloud",
    "postgres",
  ];
  expect(leftoverTestDatabases(names, (pid) => pid === 123)).toEqual(["tc_test_123_deadbeef"]);
});

it("leftoverTestDatabases by default keeps a live process, takes an exited one, keeps a non-pid", () => {
  const dead = exitedPid();
  const live = `tc_test_${process.pid}_deadbeef`;
  const gone = `tc_test_${dead}_deadbeef`;
  const huge = "tc_test_99999999999999999999_deadbeef";
  expect(leftoverTestDatabases([live, gone, huge])).toEqual([gone]);
});

it("unconnectedTestDatabases lists a test database only while nobody is connected", async () => {
  const a = await createTempDatabase({ migrate: false });
  try {
    // An autovacuum worker may be connected for an instant: wait instead of looking once.
    await expect
      .poll(() => withMaintenance(unconnectedTestDatabases), { timeout: 5000 })
      .toContain(a.name);
    const c = await a.pool.connect();
    try {
      expect(await withMaintenance(unconnectedTestDatabases)).not.toContain(a.name);
    } finally {
      c.release();
    }
  } finally {
    await a.drop();
  }
}, 60_000);

it("the sweep removes the database of an exited process", async () => {
  const name = `tc_test_${exitedPid()}_${randomBytes(4).toString("hex")}`;
  try {
    await withMaintenance((admin) => admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`));
    await sweepLeftoverTestDatabases(databaseUrl());
    // not the returned list: the sweep of another test file may have dropped it first
    expect(await databaseExists(name)).toBe(0);
  } finally {
    await withMaintenance((admin) => admin.query(`DROP DATABASE IF EXISTS "${name}"`));
  }
}, 60_000);

it("the sweep keeps a database of this process", async () => {
  const a = await createTempDatabase({ migrate: false });
  try {
    await sweepLeftoverTestDatabases(databaseUrl());
    expect(await databaseExists(a.name)).toBe(1);
  } finally {
    await a.drop();
  }
}, 60_000);

it("the sweep refuses another host", async () => {
  await expect(
    sweepLeftoverTestDatabases("postgres://u:secret-pw@db.example.test/x"),
  ).rejects.toThrow(REFUSAL);
});
