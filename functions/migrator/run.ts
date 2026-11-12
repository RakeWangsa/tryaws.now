import type { Logger } from "@tc/core";
import type { MigratorConfig } from "./config";
import { ensureRoles, type Queryable } from "./roles";

export type { Queryable };

// What the migrator does at deploy time (3.3): with the master user, over TLS only, create the five
// roles with the passwords of the linked secrets, then run the forward-only migrations. Both steps
// are idempotent (R7), so the deploy may invoke it every time. The answer holds counts only, the logs
// hold counts and step names, and every thrown error has a fixed message and no cause (R3, R14, R16).

export interface MasterConnection extends Queryable {
  end(): Promise<void>;
}

export interface MigratorDeps {
  readonly config: MigratorConfig;
  readonly connect: (url: string) => Promise<MasterConnection>;
  readonly migrate: (url: string, migrationsDir: string) => Promise<void>;
  readonly log: Logger;
}

export interface MigratorReport {
  readonly rolesCreated: number;
  readonly rolesEnabled: number;
  readonly rolesUnchanged: number;
  readonly migrationsApplied: number;
}

const COUNT_MIGRATIONS =
  "select case when to_regclass('drizzle.__drizzle_migrations') is null then 0 " +
  "else (select count(*) from drizzle.__drizzle_migrations) end::int as n";

async function migrationCount(client: Queryable): Promise<number> {
  const { rows } = await client.query(COUNT_MIGRATIONS);
  return Number(rows[0]?.n ?? 0);
}

export async function runMigrator(deps: MigratorDeps, event: unknown): Promise<MigratorReport> {
  const { config, log } = deps;
  // The deploy sends { action: "migrate" }; anything else is not for this function.
  const action =
    typeof event === "object" && event !== null
      ? (event as { action?: unknown }).action
      : undefined;
  if (action !== "migrate") throw new Error("migrator: unknown action");

  let step: "connect" | "tls" | "roles" | "migrate" = "connect";
  let client: MasterConnection | undefined;
  let refused = false;
  try {
    client = await deps.connect(config.masterUrl);

    // Refuse to run on a connection without TLS (R2, R16), before any role or table is touched.
    step = "tls";
    const { rows: ssl } = await client.query(
      "select ssl from pg_stat_ssl where pid = pg_backend_pid()",
    );
    if (ssl[0]?.ssl !== true) {
      refused = true;
      throw new Error("migrator: the connection is not encrypted");
    }

    step = "roles";
    const roles = await ensureRoles(client, config.rolePasswords);

    step = "migrate";
    const before = await migrationCount(client);
    await deps.migrate(config.masterUrl, config.migrationsDir);
    const after = await migrationCount(client);

    const report: MigratorReport = {
      rolesCreated: roles.created,
      rolesEnabled: roles.enabled,
      rolesUnchanged: roles.unchanged,
      migrationsApplied: after - before,
    };
    log({ event: "migrator_done", ...report });
    return report;
  } catch {
    // The cause is dropped on purpose: a driver message can carry the URL or a statement (R14).
    if (refused) {
      log({ event: "migrator_refused", reason: "no_tls" });
      throw new Error("migrator: the connection is not encrypted");
    }
    log({ event: "migrator_failed", step });
    if (step === "connect") throw new Error("migrator: could not connect");
    if (step === "tls") throw new Error("migrator: could not check the connection");
    if (step === "roles") throw new Error("migrator: could not prepare the roles");
    throw new Error("migrator: the migrations failed");
  } finally {
    await client?.end().catch(() => undefined);
  }
}
