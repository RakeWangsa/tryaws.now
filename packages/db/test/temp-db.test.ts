import pg from "pg";
import { expect, it } from "vitest";
import { databaseUrl } from "../env";
import { createTempDatabase, maintenanceUrl } from "./temp-db";

it("maps any URL to the maintenance database of the same server", () => {
  expect(maintenanceUrl("postgres://u:p@db.local:6543/ticoncloud?sslmode=require")).toBe(
    "postgres://u:p@db.local:6543/postgres?sslmode=require",
  );
});

it("creates, uses and drops a database with a unique name", async () => {
  const a = await createTempDatabase({ migrate: false });
  const b = await createTempDatabase({ migrate: false });
  try {
    expect(a.name).toMatch(/^tc_test_\d+_[0-9a-f]{8}$/);
    expect(a.name).not.toBe(b.name);
    const { rows } = await a.pool.query(
      "select current_database() as db, current_setting('server_version_num')::int as v",
    );
    expect(rows[0].db).toBe(a.name);
    expect(rows[0].v).toBeGreaterThanOrEqual(160000);
  } finally {
    await a.drop();
    await b.drop();
  }
  const admin = new pg.Client({ connectionString: maintenanceUrl(databaseUrl()) });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = any($1)", [
      [a.name, b.name],
    ]);
    expect(rowCount).toBe(0);
  } finally {
    await admin.end();
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

it("does not call a refused password 'cannot reach'", async () => {
  const u = new URL(databaseUrl());
  u.password = "wrong-" + u.password;
  const err = await createTempDatabase({ url: u.toString(), migrate: false }).then(
    () => null,
    (e: Error & { code?: string }) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).not.toMatch(/^cannot reach/);
  expect((err as { code?: string }).code).toBe("28P01");
}, 30_000);
