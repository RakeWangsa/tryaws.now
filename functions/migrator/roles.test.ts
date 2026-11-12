import { randomBytes } from "node:crypto";
import { createTempDatabase, type TempDatabase } from "@tc/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensureRoles } from "./roles";

// Roles belong to the whole cluster, and the migrated databases of the other test files rely on the
// real five (web_rw ...). So these tests use five roles of their own, with a random prefix, through
// the same function, and drop them again.
const prefix = `tcmt_${randomBytes(4).toString("hex")}`;
const NAMES = ["a_rw", "b_rw", "c_rw", "d", "e_ro"].map((n) => `${prefix}_${n}`);
const passwords = (suffix = ""): Record<string, string> =>
  Object.fromEntries(NAMES.map((name, i) => [name, `pw-${i}${suffix}`]));

let temp: TempDatabase;
beforeAll(async () => {
  temp = await createTempDatabase({ migrate: false });
});
afterAll(async () => {
  await dropRoles();
  await temp?.drop();
});

async function roleRows() {
  const { rows } = await temp.pool.query<{ rolname: string; rolcanlogin: boolean }>(
    "select rolname, rolcanlogin from pg_roles where rolname = any($1) order by rolname",
    [NAMES],
  );
  return rows;
}
async function verifiers() {
  const { rows } = await temp.pool.query(
    "select rolname, rolpassword from pg_authid where rolname = any($1) order by 1",
    [NAMES],
  );
  return rows;
}
async function dropRoles() {
  for (const name of NAMES) await temp.pool.query(`drop role if exists ${name}`);
}

it("creates every role with LOGIN and a hashed password when none exists, and counts only", async () => {
  await dropRoles();
  const first = await ensureRoles(temp.pool, passwords());
  expect(first).toEqual({ created: 5, enabled: 0, unchanged: 0 });
  const rows = await roleRows();
  expect(rows.map((r) => r.rolname)).toEqual([...NAMES].sort());
  expect(rows.every((r) => r.rolcanlogin)).toBe(true);
  for (const row of await verifiers()) {
    expect(String(row.rolpassword)).toMatch(/^SCRAM-SHA-256\$/);
  }
  await dropRoles();
});

it("is idempotent: a second run changes nothing, not even a verifier", async () => {
  await dropRoles();
  await ensureRoles(temp.pool, passwords());
  const before = await verifiers();
  const second = await ensureRoles(temp.pool, passwords("-other"));
  expect(second).toEqual({ created: 0, enabled: 0, unchanged: 5 });
  expect(await verifiers()).toEqual(before);
  await dropRoles();
});

it("gives LOGIN and the password to a NOLOGIN role that migration 0006 created", async () => {
  await dropRoles();
  await temp.pool.query(`create role ${NAMES[0]} nologin`);
  await temp.pool.query(`create role ${NAMES[4]} nologin`);
  const run = await ensureRoles(temp.pool, passwords());
  expect(run).toEqual({ created: 3, enabled: 2, unchanged: 0 });
  expect((await roleRows()).every((r) => r.rolcanlogin)).toBe(true);
  for (const row of await verifiers()) expect(row.rolpassword).not.toBeNull();
  await dropRoles();
});

it("leaves the password of an existing LOGIN role alone (rotation is a separate decision)", async () => {
  await dropRoles();
  await temp.pool.query(`create role ${NAMES[2]} login password 'older-secret'`);
  const before = (await verifiers())[0];
  await ensureRoles(temp.pool, passwords());
  const after = (await verifiers()).find((r) => r.rolname === NAMES[2]);
  expect(after).toEqual(before);
  await dropRoles();
});

it("quotes a hostile password as data", async () => {
  await dropRoles();
  const hostile = `x'; drop role ${NAMES[1]}; --"\\$$`;
  const run = await ensureRoles(temp.pool, { ...passwords(), [NAMES[0]!]: hostile });
  expect(run.created).toBe(5);
  expect(await roleRows()).toHaveLength(5);
  await dropRoles();
});

it("refuses an empty password before any statement", async () => {
  await dropRoles();
  await expect(ensureRoles(temp.pool, { ...passwords(), [NAMES[0]!]: "" })).rejects.toThrow(
    "migrator: a role password is missing",
  );
  expect(await roleRows()).toEqual([]);
});

it("hides the cause when a statement fails", async () => {
  const broken = {
    query: () => Promise.reject(new Error("password authentication failed for hunter2")),
  };
  try {
    await ensureRoles(broken, passwords());
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toBe("migrator: could not prepare the roles");
    expect((error as Error).cause).toBeUndefined();
  }
});
