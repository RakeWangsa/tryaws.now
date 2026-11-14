import { createTempDatabase, type TempDatabase } from "@tc/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { changedMigrations, migrationCount } from "./run";

// Staging deploy of 2026-11-14: the first migrator run on a brand-new RDS database failed with SQLSTATE
// 42P01. The count query used CASE around `select count(*) from drizzle.__drizzle_migrations`, but
// PostgreSQL resolves every table name when it parses a query, whichever branch runs. These tests use a
// real, empty database (no migrations), which the fake of run.test.ts cannot model.
let temp: TempDatabase;
beforeAll(async () => {
  temp = await createTempDatabase({ migrate: false });
});
afterAll(async () => {
  await temp?.drop();
});

const queryable = () => ({
  query: async (sql: string, params?: readonly unknown[]) => {
    const r = await temp.pool.query(sql, params === undefined ? undefined : [...params]);
    return { rows: r.rows as Record<string, unknown>[] };
  },
});

it("counts 0 applied migrations on a fresh database without the drizzle table", async () => {
  await expect(migrationCount(queryable())).resolves.toBe(0);
});

it("finds no changed migration on a fresh database", async () => {
  await expect(changedMigrations(queryable(), [])).resolves.toBe(0);
});

it("counts the rows once the drizzle table exists", async () => {
  await temp.pool.query("create schema if not exists drizzle");
  await temp.pool.query(
    "create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)",
  );
  await temp.pool.query(
    "insert into drizzle.__drizzle_migrations (hash, created_at) values ('h', 1), ('i', 2)",
  );
  await expect(migrationCount(queryable())).resolves.toBe(2);
});
