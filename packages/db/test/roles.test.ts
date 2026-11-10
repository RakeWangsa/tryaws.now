import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../migrate";
import { createTempDatabase, useTempDatabase } from "./temp-db";
import { asRole, expectSqlError, insertRow } from "./sql";
import {
  APPEND_ONLY_TABLES,
  appendOnlyRow,
  newAdmin,
  newCustomer,
  newPoolAccount,
  newResource,
  uniqueSuffix,
} from "./fixtures";

const t = useTempDatabase();

const ROLES = ["web_rw", "admin_rw", "worker_rw", "report_ro"] as const;
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;
const WEB_READ_ONLY = [
  "fx_rates",
  "pricing_rules",
  "feature_flags",
  "admin_users",
  "pool_accounts",
  "markets",
  "catalog_products",
  "tlds",
  "settings",
];

// has_table_privilege sees whole-table grants only; the column grants are tested below
function expected(role: (typeof ROLES)[number], table: string): string[] {
  if (role === "report_ro") return ["SELECT"];
  if (table === "pool_capacity") return role === "admin_rw" ? ["SELECT", "INSERT"] : ["SELECT"];
  // the six append-only tables of the specification, and the ledger accounts (ruling S13)
  const insertOnly =
    (APPEND_ONLY_TABLES as readonly string[]).includes(table) || table === "ledger_accounts";
  if (role === "web_rw") {
    if (WEB_READ_ONLY.includes(table)) return ["SELECT"];
    // INSERT and UPDATE on operations are column grants, which has_table_privilege does not see
    if (table === "operations") return ["SELECT"];
  }
  if (insertOnly) return ["SELECT", "INSERT"];
  // nobody deletes an operation (ruling S16)
  if (table === "operations") return ["SELECT", "INSERT", "UPDATE"];
  return ["SELECT", "INSERT", "UPDATE", "DELETE"];
}

it("every table of the schema has exactly the grants of the matrix", async () => {
  const tables = (
    await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
    )
  ).rows.map((r) => r.table_name as string);
  // the count of tables is proven in Task 10 (spec-sync); here the list only must not be empty
  expect(tables).toContain("operations");
  for (const table of tables)
    for (const role of ROLES) {
      const { rows } = await t.pool.query(
        `select p from unnest($3::text[]) p where has_table_privilege($1, 'public.' || quote_ident($2), p)`,
        [role, table, PRIVS],
      );
      expect({ table, role, privs: rows.map((r) => r.p) }).toEqual({
        table,
        role,
        privs: expected(role, table),
      });
    }
});

it("no application role can UPDATE or DELETE an (A) table (acceptance of WP1-T1)", async () => {
  for (const role of ["web_rw", "admin_rw", "worker_rw"] as const)
    for (const table of APPEND_ONLY_TABLES) {
      const id = await appendOnlyRow(t.pool, table);
      await expectSqlError(
        asRole(t.pool, role, (c) =>
          c.query(`update ${table} set created_at = created_at where id = $1`, [id]),
        ),
        "42501",
      );
      await expectSqlError(
        asRole(t.pool, role, (c) => c.query(`delete from ${table} where id = $1`, [id])),
        "42501",
      );
    }
});

it("web_rw cannot set operations.approved_by or change needs_approval, but can move an operation", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const op = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "destroy",
    state: "needs_approval",
    needs_approval: true,
    idempotency_key: uniqueSuffix(),
  });
  const plain = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "reboot",
    idempotency_key: uniqueSuffix(),
  });
  const admin = await newAdmin(t.pool, "ops");
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) =>
      c.query("update operations set approved_by = $1 where id = $2", [admin, op]),
    ),
    "42501",
  );
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) =>
      c.query(
        "insert into operations (id, resource_id, kind, idempotency_key, approved_by) values ($1, $2, 'destroy', $3, $4)",
        [uuidv7(), resource_id, uniqueSuffix(), admin],
      ),
    ),
    "42501",
  );
  // the column grant refuses before the trigger of Task 8 runs
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) =>
      c.query("update operations set needs_approval = false where id = $1", [op]),
    ),
    "42501",
  );
  // ruling 6: web_rw has UPDATE on state, but the CHECK keeps an unapproved operation waiting
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) =>
      c.query("update operations set state = 'running' where id = $1", [op]),
    ),
    "23514",
    { constraint: "operations_unapproved_state_check" },
  );
  const moved = await asRole(t.pool, "web_rw", (c) =>
    c.query("update operations set state = 'running' where id = $1", [plain]),
  );
  expect(moved.rowCount).toBe(1);
  const inserted = await asRole(t.pool, "web_rw", (c) =>
    c.query(
      "insert into operations (id, resource_id, kind, state, idempotency_key, needs_approval) values ($1, $2, 'destroy', 'needs_approval', $3, true)",
      [uuidv7(), resource_id, uniqueSuffix()],
    ),
  );
  expect(inserted.rowCount).toBe(1);
  const approved = await asRole(t.pool, "admin_rw", (c) =>
    c.query("update operations set approved_by = $1, state = 'queued' where id = $2", [admin, op]),
  );
  expect(approved.rowCount).toBe(1);
  // ruling 6: admin_rw has UPDATE on every column, and the trigger still keeps the flag fixed
  await expectSqlError(
    asRole(t.pool, "admin_rw", (c) =>
      c.query("update operations set needs_approval = false where id = $1", [op]),
    ),
    "23001",
    { message: /^R13: operations\.needs_approval cannot change$/ },
  );
});

it.each(WEB_READ_ONLY)("web_rw cannot write the admin-owned table %s", async (table) => {
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) => c.query(`delete from ${table}`)),
    "42501",
  );
});

it("the column grants: operations for web_rw, pool_capacity of ruling 1", async () => {
  const can = async (role: string, table: string, column: string, priv: string) =>
    (
      await t.pool.query(
        "select has_column_privilege($1, 'public.' || quote_ident($2), $3, $4) as ok",
        [role, table, column, priv],
      )
    ).rows[0].ok;
  const capacity = [
    "id",
    "created_at",
    "pool_account_id",
    "region",
    "quota_code",
    "quota_limit",
    "used",
    "checked_at",
  ];
  const updatable: Record<string, string[]> = {
    web_rw: ["used"],
    worker_rw: ["used", "checked_at"],
    admin_rw: ["quota_limit"],
    report_ro: [],
  };
  for (const [role, allowed] of Object.entries(updatable))
    for (const column of capacity) {
      expect({ role, column, ok: await can(role, "pool_capacity", column, "UPDATE") }).toEqual({
        role,
        column,
        ok: allowed.includes(column),
      });
    }
  expect(await can("web_rw", "operations", "approved_by", "INSERT")).toBe(false);
  expect(await can("web_rw", "operations", "approved_by", "UPDATE")).toBe(false);
  expect(await can("web_rw", "operations", "needs_approval", "INSERT")).toBe(true);
  expect(await can("web_rw", "operations", "needs_approval", "UPDATE")).toBe(false);
  expect(await can("web_rw", "operations", "state", "UPDATE")).toBe(true);
});

it("pool_capacity: web_rw reserves with FOR UPDATE and changes only used (ruling 1)", async () => {
  const pool_account_id = await newPoolAccount(t.pool);
  const id = await insertRow(t.pool, "pool_capacity", {
    pool_account_id,
    region: "ap-southeast-1",
    quota_code: "static_ip",
    quota_limit: 5,
  });
  const newRow = (c: PoolClient) =>
    c.query(
      "insert into pool_capacity (id, pool_account_id, region, quota_code, quota_limit) values ($1, $2, 'ap-south-1', 'bucket', 1)",
      [uuidv7(), pool_account_id],
    );
  const reserved = await asRole(t.pool, "web_rw", async (c) => {
    const locked = await c.query("select id from pool_capacity where id = $1 for update", [id]);
    expect(locked.rowCount).toBe(1);
    return c.query("update pool_capacity set used = used + 1 where id = $1", [id]);
  });
  expect(reserved.rowCount).toBe(1);
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) =>
      c.query("update pool_capacity set quota_limit = 1 where id = $1", [id]),
    ),
    "42501",
  );
  await expectSqlError(asRole(t.pool, "web_rw", newRow), "42501");
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) => c.query("delete from pool_capacity where id = $1", [id])),
    "42501",
  );
  const checked = await asRole(t.pool, "worker_rw", (c) =>
    c.query("update pool_capacity set used = 3, checked_at = now() where id = $1", [id]),
  );
  expect(checked.rowCount).toBe(1);
  await expectSqlError(
    asRole(t.pool, "worker_rw", (c) =>
      c.query("update pool_capacity set quota_limit = 1 where id = $1", [id]),
    ),
    "42501",
  );
  await expectSqlError(asRole(t.pool, "worker_rw", newRow), "42501");
  expect((await asRole(t.pool, "admin_rw", newRow)).rowCount).toBe(1);
  const limited = await asRole(t.pool, "admin_rw", (c) =>
    c.query("update pool_capacity set quota_limit = 5 where id = $1", [id]),
  );
  expect(limited.rowCount).toBe(1);
  await expectSqlError(
    asRole(t.pool, "admin_rw", (c) =>
      c.query("update pool_capacity set used = 0 where id = $1", [id]),
    ),
    "42501",
  );
  await expectSqlError(
    asRole(t.pool, "admin_rw", (c) => c.query("delete from pool_capacity where id = $1", [id])),
    "42501",
  );
});

it("report_ro only reads", async () => {
  const id = await insertRow(t.pool, "discrepancies", { kind: "cost", details: "{}" });
  const read = await asRole(t.pool, "report_ro", (c) =>
    c.query("select id, kind from discrepancies where id = $1", [id]),
  );
  expect(read.rows).toEqual([{ id, kind: "cost" }]);
  await expectSqlError(
    asRole(t.pool, "report_ro", (c) =>
      c.query("insert into discrepancies (id, kind, details) values ($1, 'cost', '{}')", [
        uuidv7(),
      ]),
    ),
    "42501",
  );
  await expectSqlError(
    asRole(t.pool, "report_ro", (c) =>
      c.query("update discrepancies set status = 'resolved' where id = $1", [id]),
    ),
    "42501",
  );
});

it("the five roles exist, are not superusers and own nothing", async () => {
  const { rows } = await t.pool.query(
    "select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = any($1) order by 1",
    [[...ROLES, "migrator"]],
  );
  expect(rows.map((r) => r.rolname)).toEqual([
    "admin_rw",
    "migrator",
    "report_ro",
    "web_rw",
    "worker_rw",
  ]);
  for (const r of rows) expect(r.rolsuper).toBe(false);
  const owned = await t.pool.query(
    "select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner where c.relnamespace = 'public'::regnamespace and r.rolname = any($1)",
    [[...ROLES, "migrator"]],
  );
  expect(owned.rows[0].n).toBe(0);
});

it("the role migration never alters an existing role and holds no password", () => {
  const sql = readFileSync(join(MIGRATIONS_FOLDER, "0006_roles_and_grants.sql"), "utf8");
  expect(sql).not.toMatch(/ALTER\s+ROLE/i);
  expect(sql).not.toMatch(/PASSWORD/i);
});

it("two databases on one server migrate at the same moment", async () => {
  const [a, b] = await Promise.all([createTempDatabase(), createTempDatabase()]);
  try {
    for (const d of [a, b]) {
      const { rows } = await d.pool.query(
        "select has_table_privilege('web_rw', 'public.ledger_entries', 'INSERT') as ok",
      );
      expect(rows[0].ok).toBe(true);
    }
  } finally {
    await Promise.all([a.drop(), b.drop()]);
  }
}, 120_000);

it("no application role can delete an operation (ruling S16)", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const op = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "destroy",
    state: "needs_approval",
    needs_approval: true,
    idempotency_key: uniqueSuffix(),
  });
  for (const role of ["web_rw", "admin_rw", "worker_rw", "report_ro"] as const) {
    await expectSqlError(
      asRole(t.pool, role, (c) => c.query("delete from operations where id = $1", [op])),
      "42501",
    );
  }
  expect(
    (await t.pool.query("select count(*)::int as n from operations where id = $1", [op])).rows[0].n,
  ).toBe(1);
});

it("no application role can change or remove a ledger account (ruling S13)", async () => {
  const customer = await newCustomer(t.pool);
  const other = await newCustomer(t.pool);
  const account = await insertRow(t.pool, "ledger_accounts", {
    type: "customer_wallet",
    customer_id: customer,
    currency: "BDT",
  });
  for (const role of ["web_rw", "admin_rw", "worker_rw"] as const) {
    await expectSqlError(
      asRole(t.pool, role, (c) =>
        c.query("update ledger_accounts set customer_id = $1 where id = $2", [other, account]),
      ),
      "42501",
    );
    await expectSqlError(
      asRole(t.pool, role, (c) => c.query("delete from ledger_accounts where id = $1", [account])),
      "42501",
    );
    const made = await asRole(t.pool, role, (c) =>
      c.query(
        "insert into ledger_accounts (id, type, customer_id, currency) values ($1, 'customer_wallet', $2, 'USD')",
        [uuidv7(), customer],
      ),
    );
    expect(made.rowCount).toBe(1);
  }
});
