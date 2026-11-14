import type { LogEvent } from "@tc/core";
import { PoolSeedConflictError } from "@tc/db/seed-pool";
import { expect, it } from "vitest";
import { runMigrator, sqlstateOf, type MigratorDeps, type Queryable } from "./run";

const CONFIG = {
  masterUrl: "postgres://master:SECRETMASTER@db.example.test:5432/ticoncloud?sslmode=verify-full",
  rolePasswords: {
    web_rw: "SECRET-1",
    admin_rw: "SECRET-2",
    worker_rw: "SECRET-3",
    migrator: "SECRET-4",
    report_ro: "SECRET-5",
  },
  migrationsDir: "/var/task/migrations",
};

// A server that knows the role catalog, the TLS flag and the migrations table.
// FILES are the migration files on disk; `rows` are the rows drizzle recorded (hash and created_at).
const FILES = [
  { folderMillis: 1000, hash: "hash-a" },
  { folderMillis: 2000, hash: "hash-b" },
];
let accountsCreated = 8;

function server(
  over: {
    ssl?: boolean;
    existing?: Record<string, boolean>;
    rows?: { hash: string; created_at: string }[];
  } = {},
) {
  const roles = new Map<string, boolean>(Object.entries(over.existing ?? {}));
  const statements: string[] = [];
  let applied = over.existing ? 3 : 0;
  const client: Queryable & { ended: boolean; end(): Promise<void> } = {
    ended: false,
    end() {
      this.ended = true;
      return Promise.resolve();
    },
    query(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("pg_stat_ssl"))
        return Promise.resolve({ rows: [{ ssl: over.ssl ?? true }] });
      if (sql.includes("from pg_roles")) {
        const wanted = (params?.[0] ?? []) as string[];
        return Promise.resolve({
          rows: wanted
            .filter((n) => roles.has(n))
            .map((n) => ({ rolname: n, rolcanlogin: roles.get(n)! })),
        });
      }
      if (sql.includes("to_regclass") && sql.includes("is not null"))
        return Promise.resolve({ rows: [{ present: over.rows !== undefined }] });
      if (sql.includes("created_at from drizzle"))
        return Promise.resolve({ rows: over.rows ?? [] });
      if (sql.includes("__drizzle_migrations")) return Promise.resolve({ rows: [{ n: applied }] });
      if (sql.startsWith("select format(")) {
        return Promise.resolve({ rows: [{ statement: `-- ${String(params?.[0])}` }] });
      }
      if (sql.startsWith("-- ")) {
        roles.set(sql.slice(3), true);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, statements, setApplied: (n: number) => (applied = n) };
}

const build = (srv = server()) => {
  const logs: LogEvent[] = [];
  const calls: string[] = [];
  const deps: MigratorDeps = {
    config: CONFIG,
    connect: (url) => {
      calls.push(`connect ${url === CONFIG.masterUrl ? "master" : "other"}`);
      return Promise.resolve(srv.client);
    },
    migrate: (url, dir) => {
      calls.push(`migrate ${dir}`);
      srv.setApplied(5);
      return Promise.resolve();
    },
    fileHashes: () => FILES,
    ensureSystemAccounts: () => {
      calls.push("accounts");
      return Promise.resolve({ created: accountsCreated });
    },
    bootstrapFirstAdmin: (url, sub) => {
      calls.push(`first-admin ${url === CONFIG.masterUrl ? "master" : "other"} ${sub}`);
      return Promise.resolve({
        outcome: "inserted",
        adminId: "0190f0e0-0000-7000-8000-000000000001",
      });
    },
    seedPoolAccount: (url, input) => {
      calls.push(
        `pool ${url === CONFIG.masterUrl ? "master" : "other"} ${input.awsAccountId} ${input.name} ${input.tier ?? "-"} ${input.stage}`,
      );
      return Promise.resolve({
        accountId: "0190f0e0-0000-7000-8000-0000000000aa",
        accountCreated: true,
        cellsCreated: 26,
        cellsExisting: 0,
      });
    },
    log: (e) => logs.push(e),
  };
  return { deps, logs, calls, srv };
};

it("checks TLS, creates the roles, runs the migrations and returns counts only", async () => {
  const { deps, calls, srv } = build();
  const out = await runMigrator(deps, { action: "migrate" });
  expect(out).toEqual({
    rolesCreated: 5,
    rolesEnabled: 0,
    rolesUnchanged: 0,
    migrationsApplied: 5,
    systemAccountsCreated: 8,
    firstAdmin: "skipped: no secret",
    poolAccount: "skipped: not configured",
  });
  expect(calls).toEqual(["connect master", "migrate /var/task/migrations", "accounts"]);
  expect(srv.client.ended).toBe(true);
  // the roles come before the migrations: 0006 then finds them
  expect(srv.statements.findIndex((s) => s.includes("pg_roles"))).toBeGreaterThan(
    srv.statements.findIndex((s) => s.includes("pg_stat_ssl")),
  );
});

it("a second run creates nothing", async () => {
  const existing = {
    web_rw: true,
    admin_rw: true,
    worker_rw: true,
    migrator: true,
    report_ro: true,
  };
  const { deps } = build(server({ existing }));
  const out = await runMigrator(deps, { action: "migrate" });
  expect(out.rolesCreated).toBe(0);
  expect(out.rolesUnchanged).toBe(5);
  expect(out.migrationsApplied).toBe(2);
});

it("refuses to run when the connection is not encrypted, before it creates a role or migrates", async () => {
  const { deps, calls, srv } = build(server({ ssl: false }));
  await expect(runMigrator(deps, { action: "migrate" })).rejects.toThrow(
    "migrator: the connection is not encrypted",
  );
  expect(calls).toEqual(["connect master"]);
  expect(srv.statements.some((s) => s.includes("pg_roles"))).toBe(false);
  expect(srv.client.ended).toBe(true);
});

it("refuses an event that is not the migrate action", async () => {
  for (const event of [undefined, {}, { action: "drop" }, { action: "MIGRATE" }, "migrate", null]) {
    const { deps, calls } = build();
    await expect(runMigrator(deps, event)).rejects.toThrow("migrator: unknown action");
    expect(calls).toEqual([]);
  }
});

it("logs and throws fixed text only, no password and no cause, when a step fails", async () => {
  const { deps, logs } = build();
  const failing: MigratorDeps = {
    ...deps,
    migrate: () =>
      Promise.reject(new Error("failed for postgres://master:SECRETMASTER@h/d SECRET-1")),
  };
  try {
    await runMigrator(failing, { action: "migrate" });
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toBe("migrator: the migrations failed");
    expect((error as Error).cause).toBeUndefined();
  }
  expect(logs).toContainEqual({ event: "migrator_failed", step: "migrate" });
  const text = JSON.stringify(logs);
  for (const secret of ["SECRETMASTER", "SECRET-1", "SECRET-5"]) expect(text).not.toContain(secret);
});

it("logs counts and never a password or the master URL", async () => {
  const { deps, logs } = build();
  await runMigrator(deps, { action: "migrate" });
  const text = JSON.stringify(logs);
  expect(logs.some((e) => e.event === "migrator_done")).toBe(true);
  for (const secret of ["SECRETMASTER", "SECRET-1", "SECRET-3", "db.example.test"]) {
    expect(text).not.toContain(secret);
  }
});

// C.10: the platform ledger accounts, after the migrations, idempotent.
it("creates the system accounts after the migrations and reports the count; a second run reports none", async () => {
  accountsCreated = 8;
  const first = build();
  expect((await runMigrator(first.deps, { action: "migrate" })).systemAccountsCreated).toBe(8);
  expect(first.calls.indexOf("accounts")).toBeGreaterThan(
    first.calls.findIndex((c) => c.startsWith("migrate")),
  );
  accountsCreated = 0;
  const second = build();
  expect((await runMigrator(second.deps, { action: "migrate" })).systemAccountsCreated).toBe(0);
  accountsCreated = 8;
});

it("does not create accounts when a migration failed, and fails with fixed text when the accounts fail", async () => {
  const { deps, calls, logs } = build();
  await expect(
    runMigrator(
      { ...deps, migrate: () => Promise.reject(new Error("boom postgres://x:y@h/d")) },
      { action: "migrate" },
    ),
  ).rejects.toThrow("migrator: the migrations failed");
  expect(calls).not.toContain("accounts");
  await expect(
    runMigrator(
      { ...deps, ensureSystemAccounts: () => Promise.reject(new Error("secret SECRET-1")) },
      { action: "migrate" },
    ),
  ).rejects.toThrow("migrator: could not prepare the ledger accounts");
  expect(logs).toContainEqual({ event: "migrator_failed", step: "accounts" });
  expect(JSON.stringify(logs)).not.toContain("SECRET-1");
});

// C.14: the hash of each applied migration file.
it("passes when every applied row matches the file of the same journal time", async () => {
  const rows = [
    { hash: "hash-a", created_at: "1000" },
    { hash: "hash-b", created_at: "2000" },
  ];
  const { deps } = build(server({ rows }));
  await expect(runMigrator(deps, { action: "migrate" })).resolves.toBeDefined();
});

it("refuses before migrating when an applied migration file changed, and says only how many", async () => {
  const rows = [
    { hash: "hash-a", created_at: "1000" },
    { hash: "EDITED-FILE-CONTENT-HASH", created_at: "2000" },
  ];
  const { deps, calls, logs, srv } = build(server({ rows }));
  await expect(runMigrator(deps, { action: "migrate" })).rejects.toThrow(
    "migrator: an applied migration changed",
  );
  expect(calls).toEqual(["connect master"]);
  expect(logs).toContainEqual({ event: "migrator_refused", reason: "migration_changed", count: 1 });
  expect(JSON.stringify(logs)).not.toContain("EDITED-FILE-CONTENT-HASH");
  expect(srv.client.ended).toBe(true);
});

it("refuses when an applied migration has no file any more (forward-only, fail closed)", async () => {
  const rows = [{ hash: "hash-z", created_at: "3000" }];
  const { deps, calls } = build(server({ rows }));
  await expect(runMigrator(deps, { action: "migrate" })).rejects.toThrow(
    "migrator: an applied migration changed",
  );
  expect(calls).toEqual(["connect master"]);
});

it("passes on a new database (no migrations table yet) and when more files than rows exist", async () => {
  await expect(runMigrator(build().deps, { action: "migrate" })).resolves.toBeDefined();
  const rows = [{ hash: "hash-a", created_at: "1000" }];
  await expect(
    runMigrator(build(server({ rows })).deps, { action: "migrate" }),
  ).resolves.toBeDefined();
});

it("fails with fixed text when the applied rows cannot be read", async () => {
  const { deps } = build();
  const failing: MigratorDeps = {
    ...deps,
    fileHashes: () => {
      throw new Error("No file /var/task/migrations/0003.sql found");
    },
  };
  await expect(runMigrator(failing, { action: "migrate" })).rejects.toThrow(
    "migrator: could not check the applied migrations",
  );
});

// WPU-Z18: the first superadmin, from the optional secret FirstAdminSub, after the ledger accounts.
const SUB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const withSub = (firstAdminSub: string | undefined, srv = server()) => {
  const b = build(srv);
  return { ...b, deps: { ...b.deps, config: { ...CONFIG, firstAdminSub } } };
};

it("inserts the first superadmin for a valid sub, lowercase, after the accounts, and logs 8 characters at most", async () => {
  const { deps, calls, logs } = withSub(SUB.toUpperCase());
  const out = await runMigrator(deps, { action: "migrate" });
  expect(out.firstAdmin).toBe("inserted");
  expect(calls).toEqual([
    "connect master",
    "migrate /var/task/migrations",
    "accounts",
    `first-admin master ${SUB}`,
  ]);
  expect(logs).toContainEqual({
    event: "migrator_first_admin",
    decision: "inserted",
    subPrefix: "0a1b2c3d",
  });
  const text = JSON.stringify(logs);
  expect(text).not.toContain(SUB);
  expect(text.toLowerCase()).not.toContain(SUB.slice(0, 9));
  // the new admin id is not logged either
  expect(text).not.toContain("0190f0e0");
});

it("does nothing when an admin row exists, and says so", async () => {
  const { deps, logs } = withSub(SUB);
  const out = await runMigrator(
    { ...deps, bootstrapFirstAdmin: () => Promise.resolve({ outcome: "admins_exist" }) },
    { action: "migrate" },
  );
  expect(out.firstAdmin).toBe("skipped: admins exist");
  expect(logs).toContainEqual({
    event: "migrator_first_admin",
    decision: "skipped: admins exist",
    subPrefix: "0a1b2c3d",
  });
  expect(JSON.stringify(logs)).not.toContain(SUB);
});

it("does not touch admin_users without a secret, with the placeholder, or with a malformed sub", async () => {
  for (const [raw, decision] of [
    [undefined, "skipped: no secret"],
    ["", "skipped: no secret"],
    ["not-configured", "skipped: no secret"],
    ["sub-123", "skipped: malformed"],
    [SUB + " ", "skipped: malformed"],
    ["{" + SUB + "}", "skipped: malformed"],
    [SUB.replace(/-/g, ""), "skipped: malformed"],
  ] as const) {
    const { deps, calls, logs } = withSub(raw);
    const out = await runMigrator(deps, { action: "migrate" });
    expect(out.firstAdmin, String(raw)).toBe(decision);
    expect(
      calls.some((c) => c.startsWith("first-admin")),
      String(raw),
    ).toBe(false);
    // a skipped run logs the decision only: no part of the value
    expect(logs).toContainEqual({ event: "migrator_first_admin", decision });
    if (raw !== undefined && raw !== "")
      expect(JSON.stringify(logs)).not.toContain(raw.slice(0, 4));
  }
});

it("does not bootstrap when the accounts failed, and fails with fixed text when the bootstrap fails", async () => {
  const { deps, calls } = withSub(SUB);
  await expect(
    runMigrator(
      { ...deps, ensureSystemAccounts: () => Promise.reject(new Error("x")) },
      { action: "migrate" },
    ),
  ).rejects.toThrow("migrator: could not prepare the ledger accounts");
  expect(calls.some((c) => c.startsWith("first-admin"))).toBe(false);
  const failing = withSub(SUB);
  await expect(
    runMigrator(
      {
        ...failing.deps,
        bootstrapFirstAdmin: () => Promise.reject(new Error(`duplicate ${SUB} SECRET-1`)),
      },
      { action: "migrate" },
    ),
  ).rejects.toThrow(/^migrator: could not bootstrap the first admin$/);
  expect(failing.logs).toContainEqual({ event: "migrator_failed", step: "first_admin" });
  const text = JSON.stringify(failing.logs);
  expect(text).not.toContain(SUB);
  expect(text).not.toContain("SECRET-1");
});

// WPU-X4: the pool account, from TC_POOL_ACCOUNT_IDS and TC_POOL_EXTERNAL_ID, after the first admin.
const POOL_ID = "111122223333";
const POOL_EXT = "tc-pool-ext-placeholder-0001";
const withPool = (
  over: { stage?: string; poolAccountIds?: string; poolExternalId?: string } = {},
  srv = server(),
) => {
  const b = build(srv);
  const config = {
    ...CONFIG,
    firstAdminSub: SUB,
    stage: "staging",
    poolAccountIds: POOL_ID,
    poolExternalId: POOL_EXT,
    ...over,
  };
  return { ...b, deps: { ...b.deps, config } };
};
const existing = () =>
  Promise.resolve({
    accountId: "0190f0e0-0000-7000-8000-0000000000aa",
    accountCreated: false,
    cellsCreated: 0,
    cellsExisting: 26,
  });

it("registers pool-1 (tier new) after the first admin, and logs the decision and the last 4 digits only", async () => {
  const { deps, calls, logs } = withPool();
  const out = await runMigrator(deps, { action: "migrate" });
  expect(out.poolAccount).toBe("inserted");
  expect(calls).toEqual([
    "connect master",
    "migrate /var/task/migrations",
    "accounts",
    `first-admin master ${SUB}`,
    `pool master ${POOL_ID} pool-1 new staging`,
  ]);
  expect(logs).toContainEqual({
    event: "migrator_pool_account",
    decision: "inserted",
    accountSuffix: "3333",
    cellsCreated: 26,
  });
  const text = JSON.stringify(logs);
  expect(text).not.toContain(POOL_ID);
  expect(text).not.toContain(POOL_EXT);
  expect(text).not.toContain(POOL_EXT.slice(0, 8));
  expect(text).not.toContain("0190f0e0-0000-7000-8000-0000000000aa");
});

it("a second deploy finds the account and reports skipped: exists (R7)", async () => {
  const { deps, logs } = withPool();
  const out = await runMigrator({ ...deps, seedPoolAccount: existing }, { action: "migrate" });
  expect(out.poolAccount).toBe("skipped: exists");
  expect(logs).toContainEqual({
    event: "migrator_pool_account",
    decision: "skipped: exists",
    accountSuffix: "3333",
    cellsCreated: 0,
  });
});

it("does not touch pool_accounts when not configured, for several accounts, or for a malformed value", async () => {
  const cases: [Record<string, string | undefined>, string][] = [
    [{ poolExternalId: undefined }, "skipped: not configured"],
    [{ poolExternalId: "" }, "skipped: not configured"],
    [{ poolAccountIds: `${POOL_ID},444455556666` }, "skipped: several pool accounts"],
    [{ poolExternalId: "too-short" }, "skipped: malformed"],
    [{ poolExternalId: "tc pool ext with a space" }, "skipped: malformed"],
    [{ poolAccountIds: "12345" }, "skipped: malformed"],
    [{ poolAccountIds: undefined }, "skipped: malformed"],
    [{ stage: undefined }, "skipped: malformed"],
  ];
  for (const [over, decision] of cases) {
    const { deps, calls, logs } = withPool(over);
    const out = await runMigrator(deps, { action: "migrate" });
    expect(out.poolAccount, JSON.stringify(over)).toBe(decision);
    expect(
      calls.some((c) => c.startsWith("pool ")),
      JSON.stringify(over),
    ).toBe(false);
    expect(logs).toContainEqual({ event: "migrator_pool_account", decision });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(POOL_ID);
    expect(text).not.toContain(POOL_EXT);
    for (const value of Object.values(over)) {
      if (typeof value === "string" && value !== "") expect(text).not.toContain(value);
    }
  }
});

it("passes the production confirmation only on the production stage", async () => {
  const seen: boolean[] = [];
  for (const stage of ["staging", "production"]) {
    const { deps } = withPool({ stage });
    await runMigrator(
      {
        ...deps,
        seedPoolAccount: (_url, input) => {
          seen.push(input.confirmProduction === true);
          return existing();
        },
      },
      { action: "migrate" },
    );
  }
  expect(seen).toEqual([false, true]);
});

// Review round 1: a stale, non-secret variable must never block every later deploy (hotfixes
// included). A row that differs is left as it is and the deploy goes on; the CLI stays strict.
it("a row that differs is skipped: logged as skipped: differs, nothing written, the deploy goes on", async () => {
  const { deps, logs } = withPool();
  const out = await runMigrator(
    {
      ...deps,
      seedPoolAccount: () =>
        Promise.reject(
          new PoolSeedConflictError(
            "the account exists and differs in name, tier or ExternalId; nothing was changed.",
          ),
        ),
    },
    { action: "migrate" },
  );
  expect(out.poolAccount).toBe("skipped: differs");
  expect(logs).toContainEqual({
    event: "migrator_pool_account",
    decision: "skipped: differs",
    accountSuffix: "3333",
  });
  expect(logs.some((e) => e.event === "migrator_refused" || e.event === "migrator_failed")).toBe(
    false,
  );
  expect(logs.some((e) => e.event === "migrator_done")).toBe(true);
  const text = JSON.stringify(logs);
  expect(text).not.toContain(POOL_EXT);
  expect(text).not.toContain(POOL_ID);
  expect(text).not.toContain("differs in name");
});

it("a database failure of the pool step fails the deploy with fixed text and no cause", async () => {
  const { deps, logs } = withPool();
  try {
    await runMigrator(
      {
        ...deps,
        seedPoolAccount: () =>
          Promise.reject(new Error(`dup ${POOL_ID} ${POOL_EXT} postgres://m:SECRETMASTER@h/d`)),
      },
      { action: "migrate" },
    );
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toBe("migrator: could not register the pool account");
    expect((error as Error).cause).toBeUndefined();
  }
  expect(logs).toContainEqual({ event: "migrator_failed", step: "pool_account" });
  const text = JSON.stringify(logs);
  for (const v of [POOL_ID, POOL_EXT, "SECRETMASTER"]) expect(text).not.toContain(v);
});

it("does not register the pool account when the first admin step failed", async () => {
  const { deps, calls } = withPool();
  await expect(
    runMigrator(
      { ...deps, bootstrapFirstAdmin: () => Promise.reject(new Error("x")) },
      { action: "migrate" },
    ),
  ).rejects.toThrow("migrator: could not bootstrap the first admin");
  expect(calls.some((c) => c.startsWith("pool "))).toBe(false);
});

// Staging deploy of 2026-11-14: "the migrations failed" with no hint. The SQLSTATE (never a message) is
// logged so a failure can be told apart without a database path (R2, R14).
it("sqlstateOf reads a five-character SQLSTATE directly or from a cause, nothing else", () => {
  expect(sqlstateOf(Object.assign(new Error("x"), { code: "42501" }))).toBe("42501");
  expect(
    sqlstateOf(new Error("wrap", { cause: Object.assign(new Error("y"), { code: "42P07" }) })),
  ).toBe("42P07");
  expect(sqlstateOf(Object.assign(new Error("z"), { code: "ECONNREFUSED" }))).toBeUndefined();
  expect(sqlstateOf(Object.assign(new Error("z"), { code: "postgres://u:p@h/d" }))).toBeUndefined();
  expect(sqlstateOf("text")).toBeUndefined();
  expect(sqlstateOf(undefined)).toBeUndefined();
});
