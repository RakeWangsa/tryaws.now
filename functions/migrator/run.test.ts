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
function server(over: { ssl?: boolean; existing?: Record<string, boolean> } = {}) {
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
  });
  expect(calls).toEqual(["connect master", "migrate /var/task/migrations"]);
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
