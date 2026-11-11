import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { NON_TENANT_TABLES, TENANT_TABLES } from "../tenancy";
import { unscopedStatements } from "../testing/sql-audit";

// The audit of the statements a repository sent (R8). It needs no database.
const actor = uuidv7();
const stmt = (sql: string, params: unknown[] = []) => ({ sql, params, actor });

it("by default it looks at every tenant table: a statement on any of them without the actor is reported", () => {
  const tables = Object.keys(TENANT_TABLES);
  expect(tables.length).toBeGreaterThan(0);
  const missed = tables.filter(
    (table) => unscopedStatements([stmt(`select * from ${table}`)]).length !== 1,
  );
  expect(missed).toEqual([]);
});

it("by default it does not look at a table that no customer owns", () => {
  const others = NON_TENANT_TABLES.filter((table) => !(table in TENANT_TABLES));
  expect(others.length).toBeGreaterThan(0);
  const reported = others.filter(
    (table) => unscopedStatements([stmt(`select * from ${table}`)]).length !== 0,
  );
  expect(reported).toEqual([]);
});

it("a digit or an underscore next to a table name makes another identifier", () => {
  expect(
    unscopedStatements([
      stmt("select * from ssh_keys2"),
      stmt("select * from x1ssh_keys"),
      stmt("select * from ssh_keys_2"),
      stmt("select * from _ssh_keys"),
      stmt("select * from ssh_keys"),
    ]).map((s) => s.sql),
  ).toEqual(["select * from ssh_keys"]);
});

it("a table is named at the start and at the end of the text, and between quotes", () => {
  expect(
    unscopedStatements(
      [stmt("ssh_keys"), stmt('"ssh_keys"'), stmt("from ssh_keys"), stmt("ssh_keys where 1=1")],
      ["ssh_keys"],
    ),
  ).toHaveLength(4);
});

it("an upper-case letter next to a name makes another identifier, an upper-case name is the same table", () => {
  expect(
    unscopedStatements([
      stmt("select * from SSH_KEYS"),
      stmt("select * from ssh_keysX"),
      stmt("select * from Xssh_keys"),
    ]).map((s) => s.sql),
  ).toEqual(["select * from SSH_KEYS"]);
});

it("refuses a call that would audit nothing: an empty list of tables", () => {
  expect(() => unscopedStatements([stmt("select * from ssh_keys")], [])).toThrow(TypeError);
  expect(() => unscopedStatements([stmt("select * from ssh_keys")], [])).toThrow(/no table/);
  // It is judged before the statements are looked at.
  expect(() => unscopedStatements([], [])).toThrow(TypeError);
});

it.each([
  ["ssh_key", "a misspelt name"],
  ["markets", "a table that no customer owns"],
  ["public.ssh_keys", "a name with a regex character"],
  ["ssh_keys|operations", "a name that is two names"],
  ["constructor", "a name that Object.prototype has"],
  ["", "an empty name"],
])("refuses the table %j (%s): it is not a key of TENANT_TABLES", (table) => {
  expect(() => unscopedStatements([stmt("select * from ssh_keys")], ["operations", table])).toThrow(
    TypeError,
  );
  expect(() => unscopedStatements([], [table])).toThrow(/not a tenant table/);
});

it("names the table it refuses", () => {
  expect(() => unscopedStatements([], ["ssh_key"])).toThrow(/ssh_key\b.*not a tenant table/);
});

it("takes any subset of the tenant tables", () => {
  const statement = stmt("select * from ssh_keys");
  expect(unscopedStatements([statement], ["ssh_keys"])).toEqual([statement]);
  expect(unscopedStatements([statement], ["operations"])).toEqual([]);
  expect(unscopedStatements([statement], ["operations", "ssh_keys"])).toEqual([statement]);
});
