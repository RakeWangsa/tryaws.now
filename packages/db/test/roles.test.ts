import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../migrate";
import { createTempDatabase, useTempDatabase } from "./temp-db";
import { asRole, expectSqlError, inTransaction, insertRow, type AppRole } from "./sql";
import {
  APPEND_ONLY_TABLES,
  appendOnlyRow,
  newAdmin,
  newCustomer,
  newLedgerAccount,
  newPoolAccount,
  newResource,
  postLedger,
  systemAccount,
  uniqueSuffix,
} from "./fixtures";

const t = useTempDatabase();

const ROLES = ["web_rw", "admin_rw", "worker_rw", "report_ro"] as const;
const ALL_FIVE = [...ROLES, "migrator"];

interface Cell {
  table: string[];
  selectColumns: string[] | null;
  insertColumns: string[] | null;
  updateColumns: string[] | null;
}
type Matrix = Record<string, Record<string, Cell>>;

const TABLE_ORDER = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const sortTablePrivs = (privs: string[]): string[] =>
  [...privs].sort((a, b) => {
    const ia = TABLE_ORDER.indexOf(a);
    const ib = TABLE_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
const sortCols = (cols: string[] | null): string[] | null =>
  cols === null ? null : [...cols].sort();

// one helper for "refused", one for "allowed": each case is one line
const refused = (role: AppRole, sql: string, params: unknown[] = []) =>
  expectSqlError(
    asRole(t.pool, role, (c) => c.query(sql, params)),
    "42501",
  );
const allowed = (role: AppRole, sql: string, params: unknown[] = []) =>
  asRole(t.pool, role, (c) => c.query(sql, params));

// ---------------------------------------------------------------------------------------------
// A. The database holds exactly the matrix

it("the database holds exactly the grants of grants.expected.json", async () => {
  const expectedRaw = JSON.parse(
    readFileSync(new URL("./grants.expected.json", import.meta.url), "utf8"),
  ) as Matrix;
  const columnRows = (
    await t.pool.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public'",
    )
  ).rows;
  const columnsOf: Record<string, string[]> = {};
  for (const r of columnRows) (columnsOf[r.table_name] ??= []).push(r.column_name);
  const tables = Object.keys(columnsOf).sort();
  // base tables only (the schema has no views)
  expect(tables).toEqual(Object.keys(expectedRaw).sort());

  const expected: Matrix = {};
  for (const table of tables) {
    expected[table] = {};
    for (const role of ROLES) {
      const cell = expectedRaw[table]![role]!;
      for (const col of [
        ...(cell.selectColumns ?? []),
        ...(cell.insertColumns ?? []),
        ...(cell.updateColumns ?? []),
      ])
        expect({ table, role, col, exists: columnsOf[table]!.includes(col) }).toEqual({
          table,
          role,
          col,
          exists: true,
        });
      expected[table]![role] = {
        table: sortTablePrivs(cell.table),
        selectColumns: sortCols(cell.selectColumns),
        insertColumns: sortCols(cell.insertColumns),
        updateColumns: sortCols(cell.updateColumns),
      };
    }
  }

  const tableGrants = (
    await t.pool.query<{
      table_name: string;
      grantee: string;
      privilege_type: string;
      is_grantable: string;
    }>(
      `select table_name, grantee, privilege_type, is_grantable from information_schema.role_table_grants
        where table_schema = 'public' and grantee = any($1)`,
      [[...ROLES]],
    )
  ).rows;
  const columnGrants = (
    await t.pool.query<{
      table_name: string;
      grantee: string;
      privilege_type: string;
      column_name: string;
      is_grantable: string;
    }>(
      `select table_name, grantee, privilege_type, column_name, is_grantable
         from information_schema.column_privileges
        where table_schema = 'public' and grantee = any($1)`,
      [[...ROLES]],
    )
  ).rows;
  expect([...tableGrants, ...columnGrants].filter((r) => r.is_grantable === "YES")).toEqual([]);
  // a column-level privilege of another kind (REFERENCES) is a failure too
  const otherColumnPrivileges = columnGrants
    .filter((r) => !["SELECT", "INSERT", "UPDATE"].includes(r.privilege_type))
    .map(({ table_name, column_name, grantee, privilege_type }) => ({
      table_name,
      column_name,
      grantee,
      privilege_type,
    }));
  expect(otherColumnPrivileges).toEqual([]);

  const actual: Matrix = {};
  for (const table of tables) {
    actual[table] = {};
    for (const role of ROLES) {
      const wholeTable = tableGrants
        .filter((r) => r.table_name === table && r.grantee === role)
        .map((r) => r.privilege_type);
      const columnList = (priv: string): string[] | null => {
        const cols = columnGrants
          .filter((r) => r.table_name === table && r.grantee === role && r.privilege_type === priv)
          .map((r) => r.column_name)
          .sort();
        if (wholeTable.includes(priv)) {
          // the column view lists every column of the table for a whole-table privilege
          expect({ table, role, priv, cols }).toEqual({
            table,
            role,
            priv,
            cols: [...columnsOf[table]!].sort(),
          });
          return null;
        }
        return cols.length > 0 ? cols : null;
      };
      actual[table][role] = {
        table: sortTablePrivs(wholeTable),
        selectColumns: columnList("SELECT"),
        insertColumns: columnList("INSERT"),
        updateColumns: columnList("UPDATE"),
      };
    }
  }
  expect(actual).toEqual(expected);
});

it("PUBLIC and migrator hold no privilege on any table", async () => {
  for (const view of ["table_privileges", "column_privileges"]) {
    const { rows } = await t.pool.query(
      `select count(*)::int as n from information_schema.${view}
        where table_schema = 'public' and grantee in ('PUBLIC', 'migrator')`,
    );
    expect({ view, n: rows[0].n }).toEqual({ view, n: 0 });
  }
});

it("only migrator may create objects in the schema", async () => {
  const has = async (role: string, priv: string) =>
    (await t.pool.query("select has_schema_privilege($1, 'public', $2) as ok", [role, priv]))
      .rows[0].ok;
  for (const role of ROLES) {
    expect({ role, usage: await has(role, "USAGE"), create: await has(role, "CREATE") }).toEqual({
      role,
      usage: true,
      create: false,
    });
  }
  expect({
    usage: await has("migrator", "USAGE"),
    create: await has("migrator", "CREATE"),
  }).toEqual({ usage: true, create: true });
});

it("one DELETE in the whole matrix: the customer panel deletes an SSH key", async () => {
  const { rows } = await t.pool.query(
    `select table_name, grantee from information_schema.role_table_grants
      where table_schema = 'public' and privilege_type = 'DELETE' and grantee = any($1)`,
    [[...ROLES]],
  );
  expect(rows).toEqual([{ table_name: "ssh_keys", grantee: "web_rw" }]);
  const tables = (
    await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
    )
  ).rows.map((r) => r.table_name as string);
  for (const role of ROLES)
    for (const table of tables) {
      if (role === "web_rw" && table === "ssh_keys") {
        const res = await allowed(role, `delete from ${table} where false`);
        expect(res.rowCount).toBe(0);
      } else {
        await refused(role, `delete from ${table} where false`);
      }
    }
});

it("a table added later gets no grant", async () => {
  expect((await t.pool.query("select count(*)::int as n from pg_default_acl")).rows[0].n).toBe(0);
  await t.pool.query("create table zz_later (id uuid primary key)");
  try {
    for (const role of ALL_FIVE) {
      const { rows } = await t.pool.query(
        "select has_table_privilege($1, 'public.zz_later', 'SELECT') as ok",
        [role],
      );
      expect({ role, ok: rows[0].ok }).toEqual({ role, ok: false });
    }
  } finally {
    await t.pool.query("drop table zz_later");
  }
});

it("the role migration grants nothing wholesale", () => {
  const sql = readFileSync(join(MIGRATIONS_FOLDER, "0006_roles_and_grants.sql"), "utf8");
  expect(sql).not.toMatch(/ALTER\s+ROLE/i);
  expect(sql).not.toMatch(/PASSWORD/i);
  expect(sql).not.toMatch(/ALL\s+PRIVILEGES/i);
  expect(sql).not.toMatch(/ALL\s+TABLES/i);
  expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  expect(sql).not.toMatch(/TRUNCATE/i);
  expect(sql).not.toMatch(/WITH\s+GRANT\s+OPTION/i);
  expect(sql).not.toMatch(/GRANT[^;]*\sTO\s[^;]*\bPUBLIC\b/i);
});

// Two migrations that create the roles at the same moment: the loser gets unique_violation (23505)
// from the catalog index, not duplicate_object (42710). No test can reach that race on a server that
// already has the roles, so the text of the role block is pinned here.
it("the role block survives a CREATE ROLE that runs at the same moment", () => {
  const sql = readFileSync(join(MIGRATIONS_FOLDER, "0006_roles_and_grants.sql"), "utf8");
  expect(sql).toMatch(/EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;/);
});

it("the five roles exist with no special attribute, no membership in one another and no ownership", async () => {
  // Roles are server-wide: WP0-T3 lets them log in or makes login users members of them, so LOGIN
  // and memberships of users outside the five are not asserted here.
  const { rows } = await t.pool.query(
    `select rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
       from pg_roles where rolname = any($1) order by 1`,
    [ALL_FIVE],
  );
  expect(rows.map((r) => r.rolname)).toEqual([
    "admin_rw",
    "migrator",
    "report_ro",
    "web_rw",
    "worker_rw",
  ]);
  for (const r of rows)
    expect(r).toEqual({
      rolname: r.rolname,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  const members = await t.pool.query(
    `select count(*)::int as n from pg_auth_members m
       join pg_roles a on a.oid = m.member join pg_roles b on b.oid = m.roleid
      where a.rolname = any($1) and b.rolname = any($1)`,
    [ALL_FIVE],
  );
  expect(members.rows[0].n).toBe(0);
  const owned = await t.pool.query(
    "select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner where c.relnamespace = 'public'::regnamespace and r.rolname = any($1)",
    [ALL_FIVE],
  );
  expect(owned.rows[0].n).toBe(0);
});

// ---------------------------------------------------------------------------------------------
// B. The acceptance of WP1-T1 and the earlier rulings

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
  for (const [role, allowedColumns] of Object.entries(updatable))
    for (const column of capacity) {
      expect({ role, column, ok: await can(role, "pool_capacity", column, "UPDATE") }).toEqual({
        role,
        column,
        ok: allowedColumns.includes(column),
      });
    }
  const operationColumns = (
    await t.pool.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'operations'",
    )
  ).rows.map((r) => r.column_name as string);
  for (const column of operationColumns)
    expect({ column, ok: await can("web_rw", "operations", column, "UPDATE") }).toEqual({
      column,
      ok: false,
    });
  expect(await can("web_rw", "operations", "needs_approval", "INSERT")).toBe(true);
  expect(await can("web_rw", "operations", "approved_by", "INSERT")).toBe(false);
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

it("two databases on one server migrate at the same moment when the roles already exist", async () => {
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
    await refused(role, "delete from operations where id = $1", [op]);
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
  const insert =
    "insert into ledger_accounts (id, type, customer_id, currency) values ($1, 'customer_wallet', $2, 'USD')";
  for (const role of ["web_rw", "admin_rw", "worker_rw"] as const) {
    await refused(role, "update ledger_accounts set customer_id = $1 where id = $2", [
      other,
      account,
    ]);
    await refused(role, "delete from ledger_accounts where id = $1", [account]);
  }
  expect((await allowed("web_rw", insert, [uuidv7(), customer])).rowCount).toBe(1);
  await refused("admin_rw", insert, [uuidv7(), customer]);
  await refused("worker_rw", insert, [uuidv7(), customer]);
});

// asRole always rolls back, so COMMIT never runs in this file. SET CONSTRAINTS ALL IMMEDIATE fires the
// deferred balance check at once, with the privileges of the role: it reads ledger_transactions,
// ledger_entries and ledger_accounts.
it.each(["web_rw", "admin_rw", "worker_rw"] as const)(
  "%s posts a ledger transaction, and the balance check runs with its privileges",
  async (role) => {
    const clearing = await systemAccount(t.pool, "gateway_clearing");
    const wallet = await newLedgerAccount(t.pool, "customer_wallet", await newCustomer(t.pool));
    await asRole(t.pool, role, async (c) => {
      await postLedger(c, "bal-" + uniqueSuffix(), [
        [clearing, "debit", 1000],
        [wallet, "credit", 1000],
      ]);
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    await expectSqlError(
      asRole(t.pool, role, async (c) => {
        await postLedger(c, "unbal-" + uniqueSuffix(), [
          [clearing, "debit", 1000],
          [wallet, "credit", 999],
        ]);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      }),
      "23514",
      { message: /^ledger transaction [0-9a-f-]{36} is not balanced$/ },
    );
  },
);

// Tables that web_rw only reads, or does not see at all. The list stands here on purpose and is not
// read from grants.expected.json: a grant that arrives together with an edit of that file fails here.
//   - section 3.3 of the specification: fx_rates, pricing_rules, feature_flags, admin_users, pool_accounts
//   - written only by the admin panel: wallet_adjustments, abuse_cases, settings
//   - written only by the functions: catalog_products, tlds, usage_records
//   - written by no application role: markets
const WEB_CANNOT_WRITE = [
  "fx_rates",
  "pricing_rules",
  "feature_flags",
  "admin_users",
  "pool_accounts",
  "wallet_adjustments",
  "abuse_cases",
  "settings",
  "catalog_products",
  "tlds",
  "usage_records",
  "markets",
] as const;

it.each(WEB_CANNOT_WRITE)(
  "web_rw cannot write %s (acceptance of WP1-T1: the admin-owned tables, and every other table it only reads)",
  async (table) => {
    const { rows } = await t.pool.query(
      `select has_any_column_privilege('web_rw', 'public.' || quote_ident($1), 'INSERT') as can_insert,
              has_any_column_privilege('web_rw', 'public.' || quote_ident($1), 'UPDATE') as can_update,
              has_table_privilege('web_rw', 'public.' || quote_ident($1), 'DELETE') as can_delete,
              has_table_privilege('web_rw', 'public.' || quote_ident($1), 'TRUNCATE') as can_truncate`,
      [table],
    );
    expect(rows[0]).toEqual({
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    });
    // statements that read no column, so that only the missing write privilege can refuse them
    await refused("web_rw", `insert into ${table} (id) values ($1)`, [uuidv7()]);
    await refused("web_rw", `update ${table} set id = $1 where false`, [uuidv7()]);
    await refused("web_rw", `delete from ${table} where false`);
  },
);

it("web_rw can report a discrepancy and cannot change or remove one", async () => {
  const { rows } = await t.pool.query(
    `select has_any_column_privilege('web_rw', 'public.discrepancies', 'UPDATE') as can_update,
            has_table_privilege('web_rw', 'public.discrepancies', 'DELETE') as can_delete`,
  );
  expect(rows[0]).toEqual({ can_update: false, can_delete: false });
  await refused("web_rw", "update discrepancies set status = 'resolved' where false");
  await refused("web_rw", "delete from discrepancies where false");
  const reported = await allowed(
    "web_rw",
    "insert into discrepancies (id, kind, details) values ($1, 'cost', '{}')",
    [uuidv7()],
  );
  expect(reported.rowCount).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// C. What each role cannot do and what its flows can

async function seedVictim() {
  const attacker = await newCustomer(t.pool);
  const victim = await newCustomer(t.pool);
  const attackerResource = await newResource(t.pool, attacker);
  const victimResource = await newResource(t.pool, victim);
  const admin = await newAdmin(t.pool, "ops");
  const otherAdmin = await newAdmin(t.pool, "finance");
  const approvedDestroy = await insertRow(t.pool, "operations", {
    resource_id: attackerResource,
    kind: "destroy",
    state: "queued",
    needs_approval: true,
    approved_by: admin,
    idempotency_key: uniqueSuffix(),
  });
  const waitingDestroy = await insertRow(t.pool, "operations", {
    resource_id: victimResource,
    kind: "destroy",
    state: "needs_approval",
    needs_approval: true,
    idempotency_key: uniqueSuffix(),
  });
  return {
    attacker,
    victim,
    attackerResource,
    victimResource,
    admin,
    otherAdmin,
    approvedDestroy,
    waitingDestroy,
  };
}

it("web_rw: a compromised customer panel cannot approve, credit or re-point; the customer flows work", async () => {
  const s = await seedVictim();
  const subscription = await insertRow(t.pool, "subscriptions", {
    resource_id: s.victimResource,
    customer_id: s.victim,
    term_days: 30,
    price_snapshot: "{}",
    period_start: new Date(Date.now() - 5 * 86400_000),
    period_end: new Date(Date.now() + 25 * 86400_000),
    status: "active",
  });
  const payment = await insertRow(t.pool, "payments", {
    customer_id: s.victim,
    gateway: "eps",
    merchant_transaction_id: "MTX-" + uniqueSuffix(),
    idempotency_key: uniqueSuffix(),
    amount_minor: 1000,
    currency: "BDT",
  });
  const kyc = await insertRow(t.pool, "kyc_submissions", {
    customer_id: s.victim,
    document_type: "nid",
    document_number_encrypted: Buffer.from("deadbeef", "hex"),
    s3_keys: "{kyc/x/front.jpg}",
  });

  // refused
  await refused("web_rw", "update operations set resource_id = $1 where id = $2", [
    s.victimResource,
    s.approvedDestroy,
  ]);
  await refused("web_rw", "update operations set state = 'running' where id = $1", [
    s.approvedDestroy,
  ]);
  await refused("web_rw", "update operations set payload = '{}' where id = $1", [
    s.approvedDestroy,
  ]);
  await refused(
    "web_rw",
    "insert into operations (id, resource_id, kind, idempotency_key, approved_by) values ($1, $2, 'destroy', $3, $4)",
    [uuidv7(), s.victimResource, uniqueSuffix(), s.admin],
  );
  await refused("web_rw", "update customers set kyc_status = 'verified' where id = $1", [
    s.attacker,
  ]);
  await refused("web_rw", "update customers set risk_tier = 'trusted' where id = $1", [s.attacker]);
  await refused("web_rw", "update customers set status = 'active' where id = $1", [s.attacker]);
  await refused(
    "web_rw",
    "insert into wallet_adjustments (id, customer_id, direction, amount_minor, kind, reason, requested_by) values ($1, $2, 'credit', 100, 'goodwill', 'x', $3)",
    [uuidv7(), s.attacker, s.admin],
  );
  await refused("web_rw", "select id from wallet_adjustments");
  await refused("web_rw", "update kyc_submissions set status = 'verified' where id = $1", [kyc]);
  await refused("web_rw", "select role_arn, external_id from pool_accounts");
  await refused("web_rw", "select * from admin_users");
  await refused(
    "web_rw",
    "insert into resources (id, customer_id, family, aws_name) values ($1, $2, 'linux_instance', 'customer-text')",
    [uuidv7(), s.attacker],
  );
  await refused(
    "web_rw",
    "update subscriptions set price_snapshot = '{\"total\":0}' where id = $1",
    [subscription],
  );
  await refused("web_rw", "select verify_payload from payments where id = $1", [payment]);
  await refused("web_rw", "select payload from operations");
  await refused(
    "web_rw",
    "insert into abuse_cases (id, resource_id, source) values ($1, $2, 'admin')",
    [uuidv7(), s.attackerResource],
  );

  // allowed: sign-up in one transaction
  const signUp = await asRole(t.pool, "web_rw", async (c) => {
    const customer = uuidv7();
    await c.query(
      "insert into customers (id, cognito_sub, email, phone, name, type, market, locale) values ($1, $2, $3, $4, 'New Customer', 'individual', 'BD', 'bn')",
      [
        customer,
        "sub-" + uniqueSuffix(),
        uniqueSuffix() + "@example.test",
        "+88017" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"),
      ],
    );
    await c.query("insert into wallets (id, customer_id, currency) values ($1, $2, 'BDT')", [
      uuidv7(),
      customer,
    ]);
    await c.query(
      "insert into ledger_accounts (id, type, customer_id, currency) values ($1, 'customer_wallet', $2, 'BDT')",
      [uuidv7(), customer],
    );
    return c.query(
      "select balance_minor::text as balance, version from wallets where customer_id = $1",
      [customer],
    );
  });
  expect(signUp.rows).toEqual([{ balance: "0", version: 0 }]);

  // not a grant: a second system account of the same type and currency
  await systemAccount(t.pool, "gateway_clearing", "BDT");
  await expectSqlError(
    allowed(
      "web_rw",
      "insert into ledger_accounts (id, type, customer_id, currency) values ($1, 'gateway_clearing', null, 'BDT')",
      [uuidv7()],
    ),
    "23505",
    { constraint: "ledger_accounts_customer_id_type_currency_unique" },
  );

  // allowed: an operation that needs approval, the pool tiers, renewNow, the SSH key
  const queued = await allowed(
    "web_rw",
    "insert into operations (id, resource_id, kind, state, idempotency_key, payload, needs_approval) values ($1, $2, 'destroy', 'needs_approval', $3, '{}', true)",
    [uuidv7(), s.victimResource, uniqueSuffix()],
  );
  expect(queued.rowCount).toBe(1);
  await newPoolAccount(t.pool);
  expect(
    (await allowed("web_rw", "select id, tier, status from pool_accounts")).rowCount,
  ).toBeGreaterThan(0);
  await t.pool.query(
    "insert into tlds (id, tld, synced_at) values ($1, 'com', now()) on conflict do nothing",
    [uuidv7()],
  );
  const order = await asRole(t.pool, "web_rw", async (c) => {
    const resource = uuidv7();
    await c.query(
      "insert into resources (id, customer_id, family, region) values ($1, $2, 'domain', 'us-east-1')",
      [resource, s.victim],
    );
    await c.query(
      "insert into domains (id, customer_id, resource_id, name, tld, status, registrant_contact_encrypted) values ($1, $2, $3, 'example-c2.com', 'com', 'pending', $4)",
      [uuidv7(), s.victim, resource, Buffer.from("c0ffee", "hex")],
    );
    return c.query(
      "insert into dns_zones (id, customer_id, resource_id, name, status) values ($1, $2, $3, 'example-c2.com', 'pending')",
      [uuidv7(), s.victim, resource],
    );
  });
  expect(order.rowCount).toBe(1);
  const renewed = await allowed(
    "web_rw",
    "update subscriptions set period_start = period_end, period_end = period_end + interval '30 days', status = 'active', auto_renew = true where id = $1",
    [subscription],
  );
  expect(renewed.rowCount).toBe(1);
  const keyed = await asRole(t.pool, "web_rw", async (c) => {
    const key = uuidv7();
    await c.query(
      "insert into ssh_keys (id, customer_id, name, public_key, fingerprint) values ($1, $2, 'k', 'ssh-ed25519 AAAA', $3)",
      [key, s.victim, "SHA256:" + uniqueSuffix()],
    );
    return c.query("delete from ssh_keys where id = $1", [key]);
  });
  expect(keyed.rowCount).toBe(1);
});

it("admin_rw: no delete, no capacity counter, no pool secrets; the admin actions work", async () => {
  const s = await seedVictim();
  const pool_account_id = await newPoolAccount(t.pool);
  const capacity = await insertRow(t.pool, "pool_capacity", {
    pool_account_id,
    region: "ap-southeast-1",
    quota_code: "static_ip",
    quota_limit: 5,
  });
  const kyc = await insertRow(t.pool, "kyc_submissions", {
    customer_id: s.victim,
    document_type: "nid",
    document_number_encrypted: Buffer.from("deadbeef", "hex"),
    s3_keys: "{kyc/x/front.jpg}",
  });

  // refused
  await refused("admin_rw", "delete from customers where id = $1", [s.victim]);
  await refused("admin_rw", "update pool_capacity set used = 0 where id = $1", [capacity]);
  await refused("admin_rw", "select role_arn, external_id from pool_accounts");
  await refused(
    "admin_rw",
    "insert into wallet_adjustments (id, customer_id, direction, amount_minor, kind, reason, requested_by, approved_by) values ($1, $2, 'credit', 100, 'goodwill', 'x', $3, $4)",
    [uuidv7(), s.victim, s.admin, s.otherAdmin],
  );
  await refused("admin_rw", "update customers set email = 'x@example.test' where id = $1", [
    s.victim,
  ]);
  await refused("admin_rw", "update operations set payload = '{}' where id = $1", [
    s.waitingDestroy,
  ]);
  // the trigger of 0005_triggers.sql still keeps the flag fixed; the column grant refuses first
  await refused("admin_rw", "update operations set needs_approval = false where id = $1", [
    s.waitingDestroy,
  ]);

  // allowed
  const approved = await allowed(
    "admin_rw",
    "update operations set state = 'queued', approved_by = $1, next_run_at = now(), enqueue_seq = enqueue_seq + 1 where id = $2 returning id, enqueue_seq",
    [s.admin, s.waitingDestroy],
  );
  expect(approved.rows).toEqual([{ id: s.waitingDestroy, enqueue_seq: 1 }]);
  const kycDone = await asRole(t.pool, "admin_rw", async (c) => {
    const review = await c.query(
      "update kyc_submissions set status = 'verified', reviewer_id = $1, reviewed_at = now() where id = $2",
      [s.admin, kyc],
    );
    const customer = await c.query("update customers set kyc_status = 'verified' where id = $1", [
      s.victim,
    ]);
    return [review.rowCount, customer.rowCount];
  });
  expect(kycDone).toEqual([1, 1]);
  const abuse = await allowed(
    "admin_rw",
    "insert into abuse_cases (id, resource_id, source, notes) values ($1, $2, 'admin', 'n')",
    [uuidv7(), s.victimResource],
  );
  expect(abuse.rowCount).toBe(1);
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", s.victim);
  const adjustments = await systemAccount(t.pool, "adjustments");
  const posted = await inTransaction(t.pool, (c) =>
    postLedger(c, "adj-" + uniqueSuffix(), [
      [adjustments, "debit", 100],
      [wallet, "credit", 100],
    ]),
  );
  const adjusted = await asRole(t.pool, "admin_rw", async (c) => {
    const id = uuidv7();
    await c.query(
      "insert into wallet_adjustments (id, customer_id, direction, amount_minor, kind, reason, requested_by) values ($1, $2, 'credit', 100, 'goodwill', 'x', $3)",
      [id, s.victim, s.admin],
    );
    return c.query(
      "update wallet_adjustments set approved_by = $1, status = 'approved', ledger_transaction_id = $3 where id = $2",
      [s.otherAdmin, id, posted],
    );
  });
  expect(adjusted.rowCount).toBe(1);
});

it("worker_rw: no admin data, no approval, no purge; the functions' steps work", async () => {
  const s = await seedVictim();
  const payment = await insertRow(t.pool, "payments", {
    customer_id: s.victim,
    gateway: "eps",
    merchant_transaction_id: "MTX-" + uniqueSuffix(),
    idempotency_key: uniqueSuffix(),
    amount_minor: 1000,
    currency: "BDT",
  });
  await newPoolAccount(t.pool);
  await insertRow(t.pool, "feature_flags", { key: "instances", market: "BD", enabled: false });

  // refused
  await refused("worker_rw", "select verify_payload from payments");
  await refused("worker_rw", "update feature_flags set enabled = true where key = 'instances'");
  await refused("worker_rw", "update operations set approved_by = $1 where id = $2", [
    s.admin,
    s.waitingDestroy,
  ]);
  await refused("worker_rw", "delete from rate_limits");
  await refused("worker_rw", "select * from admin_users");
  await refused("worker_rw", "select cognito_sub from admin_users");
  await refused("worker_rw", "update admin_users set status = 'disabled' where id = $1", [s.admin]);
  await refused(
    "worker_rw",
    "insert into admin_users (id, cognito_sub, role, status) values ($1, 'x', 'ops', 'active')",
    [uuidv7()],
  );
  await refused(
    "worker_rw",
    "insert into settings (id, key, market, scope, value) values ($1, 'x', 'BD', 'market', '1')",
    [uuidv7()],
  );
  await refused("worker_rw", "update customers set status = 'suspended' where id = $1", [s.victim]);
  await refused("worker_rw", "select * from kyc_submissions");

  // allowed
  const named = await allowed(
    "worker_rw",
    "update resources set aws_name = 'tc-instance-0000000000000102b' where id = $1",
    [s.victimResource],
  );
  expect(named.rowCount).toBe(1);
  expect(
    (await allowed("worker_rw", "select code, currency, numerals from markets")).rowCount,
  ).toBeGreaterThan(0);
  expect(
    (await allowed("worker_rw", "select status from admin_users where id = $1", [s.admin])).rows,
  ).toEqual([{ status: "active" }]);
  const paid = await allowed(
    "worker_rw",
    "select id, status, amount_minor from payments where id = $1",
    [payment],
  );
  expect(paid.rowCount).toBe(1);
  const resent = await allowed(
    "worker_rw",
    "update operations set enqueue_seq = enqueue_seq + 1 where id = $1",
    [s.approvedDestroy],
  );
  expect(resent.rowCount).toBe(1);
  expect(
    (
      await allowed(
        "worker_rw",
        "select id, aws_account_id, role_arn, external_id, status from pool_accounts",
      )
    ).rowCount,
  ).toBeGreaterThan(0);
});

it("report_ro reads four tables in part and writes nothing", async () => {
  const s = await seedVictim();
  const id = await insertRow(t.pool, "discrepancies", { kind: "cost", details: "{}" });
  await refused("report_ro", "select * from payments");
  await refused("report_ro", "select role_arn from pool_accounts");
  await refused("report_ro", "select * from customers");
  await refused(
    "report_ro",
    "insert into discrepancies (id, kind, details) values ($1, 'cost', '{}')",
    [uuidv7()],
  );
  await refused("report_ro", "update discrepancies set status = 'resolved' where id = $1", [id]);

  await allowed("report_ro", "select status, count(*) from payments group by status");
  await allowed("report_ro", "select state, count(*) from operations group by state");
  const read = await allowed("report_ro", "select id, kind from discrepancies where id = $1", [id]);
  expect(read.rows).toEqual([{ id, kind: "cost" }]);
  const resources = await allowed("report_ro", "select id, family, state from resources");
  expect(resources.rows.map((r) => r.id)).toContain(s.victimResource);
});
