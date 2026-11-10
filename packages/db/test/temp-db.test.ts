import pg from "pg";
import { expect, it } from "vitest";
import { databaseUrl } from "../env";
import { createTempDatabase, isNetworkError, maintenanceUrl, type TempDatabase } from "./temp-db";

async function databaseExists(...names: string[]): Promise<number> {
  const admin = new pg.Client({ connectionString: maintenanceUrl(databaseUrl()) });
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
