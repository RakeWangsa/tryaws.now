import type { LogEvent } from "@tc/core";
import { expect, it } from "vitest";
import { runMigrator, type MigratorDeps, type Queryable } from "./run";

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
