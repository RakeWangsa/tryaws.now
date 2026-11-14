import type { Logger } from "@tc/core";
import {
  firstAdminDecision,
  subPrefix,
  type FirstAdminDecision,
  type FirstAdminOutcome,
} from "@tc/db";
import {
  accountSuffix,
  isPoolSeedConflict,
  poolAccountDecision,
  type PoolAccountDecision,
  type SeedPoolInput,
  type SeedPoolResult,
} from "@tc/db/seed-pool";
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

export interface MigrationFileHash {
  readonly folderMillis: number;
  readonly hash: string;
}

export interface MigratorDeps {
  readonly config: MigratorConfig;
  readonly connect: (url: string) => Promise<MasterConnection>;
  readonly migrate: (url: string, migrationsDir: string) => Promise<void>;
  /** The hash of every migration file of the folder (C.14): compared with the applied rows. */
  readonly fileHashes: (migrationsDir: string) => readonly MigrationFileHash[];
  /** C.10: creates the platform ledger accounts that do not exist yet, as the table owner. Idempotent. */
  readonly ensureSystemAccounts: (url: string) => Promise<{ readonly created: number }>;
  /**
   * WPU-Z18: in one transaction as the table owner, inserts one superadmin for `sub` only when
   * admin_users has no row at all (bootstrapFirstSuperadmin of @tc/db). Idempotent.
   */
  readonly bootstrapFirstAdmin: (url: string, sub: string) => Promise<FirstAdminOutcome>;
  /**
   * WPU-X4: as the table owner, seedPoolAccount of @tc/db (one transaction on one connection): the
   * pool account and its capacity cells when absent; never changes an existing row. Idempotent.
   */
  readonly seedPoolAccount: (url: string, input: SeedPoolInput) => Promise<SeedPoolResult>;
  readonly log: Logger;
}

export interface MigratorReport {
  readonly rolesCreated: number;
  readonly rolesEnabled: number;
  readonly rolesUnchanged: number;
  readonly migrationsApplied: number;
  readonly systemAccountsCreated: number;
  /** WPU-Z18: what the first-superadmin bootstrap did; never the sub. */
  readonly firstAdmin: FirstAdminDecision;
  /** WPU-X4: what the pool account bootstrap did; never the account id or the ExternalId. */
  readonly poolAccount: PoolAccountDecision;
}

const APPLIED_MIGRATIONS =
  "select hash, created_at from drizzle.__drizzle_migrations order by created_at";

/**
 * C.14. drizzle stores the sha256 of each migration file it applied and never looks at it again. Here
 * every applied row must match the file of the same journal time, byte for byte; an edited file, or an
 * applied migration that has no file any more, stops the deploy before anything else is touched
 * (R15: migrations are forward-only; R16: fail closed). Returns the count of mismatches (0 = fine).
 */
export async function changedMigrations(
  client: Queryable,
  files: readonly MigrationFileHash[],
): Promise<number> {
  const exists = await client.query(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
  );
  if (exists.rows[0]?.present !== true) return 0;
  const { rows } = await client.query(APPLIED_MIGRATIONS);
  const byTime = new Map(files.map((f) => [f.folderMillis, f.hash]));
  let changed = 0;
  for (const row of rows) {
    if (byTime.get(Number(row.created_at)) !== row.hash) changed += 1;
  }
  return changed;
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

  let step:
    | "connect"
    | "tls"
    | "roles"
    | "verify"
    | "migrate"
    | "accounts"
    | "first_admin"
    | "pool_account" = "connect";
  let client: MasterConnection | undefined;
  let refused = false;
  let changed = 0;
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

    // C.14: before any migration runs, an applied migration whose file changed stops the deploy.
    step = "verify";
    changed = await changedMigrations(client, deps.fileHashes(config.migrationsDir));
    if (changed > 0) throw new Error("migrator: an applied migration changed");

    step = "migrate";
    const before = await migrationCount(client);
    await deps.migrate(config.masterUrl, config.migrationsDir);
    const after = await migrationCount(client);

    // C.10: the platform ledger accounts (postTransaction never creates one). Runs after the
    // migrations, as the table owner, and is idempotent: a second run creates none.
    step = "accounts";
    const accounts = await deps.ensureSystemAccounts(config.masterUrl);

    // WPU-Z18: the first superadmin, when FirstAdminSub holds a canonical UUID and admin_users has no
    // row at all. An unset, placeholder or malformed value writes nothing. The log holds the decision
    // and at most the first 8 characters of a valid sub (R14), never the new admin id.
    step = "first_admin";
    const plan = firstAdminDecision(config.firstAdminSub);
    let firstAdmin: FirstAdminDecision;
    if (plan.kind === "skip") {
      firstAdmin = plan.decision;
      log({ event: "migrator_first_admin", decision: firstAdmin });
    } else {
      const done = await deps.bootstrapFirstAdmin(config.masterUrl, plan.sub);
      firstAdmin = done.outcome === "inserted" ? "inserted" : "skipped: admins exist";
      log({ event: "migrator_first_admin", decision: firstAdmin, subPrefix: subPrefix(plan.sub) });
    }

    // WPU-X4: the one pool account and its capacity cells, from TC_POOL_ACCOUNT_IDS (exactly one id) and
    // TC_POOL_EXTERNAL_ID, with the alias pool-1, tier new and the seed's placeholder limits. Unset,
    // several ids or a malformed value write nothing. An existing account is never changed (R7). A row
    // that differs (same id with another name, tier or ExternalId, or pool-1 on another id) is left as
    // it is and logged `skipped: differs`: a stale, non-secret variable must never block every later
    // deploy, hotfixes included (review round 1); the CLI stays strict. Any other error fails the
    // deploy, as every other error of a migrator step does (R16). The seed writes its audit row in the
    // same transaction (review M2). The log holds the decision and at most the last 4 digits of the
    // account id, never the ExternalId (R14).
    step = "pool_account";
    const poolPlan = poolAccountDecision({
      stage: config.stage,
      accountIds: config.poolAccountIds,
      externalId: config.poolExternalId,
    });
    let poolAccount: PoolAccountDecision;
    if (poolPlan.kind === "skip") {
      poolAccount = poolPlan.decision;
      log({ event: "migrator_pool_account", decision: poolAccount });
    } else {
      const suffix = accountSuffix(poolPlan.input.awsAccountId);
      let seeded: SeedPoolResult | undefined;
      try {
        seeded = await deps.seedPoolAccount(config.masterUrl, poolPlan.input);
      } catch (error) {
        // The seed rolled its transaction back: nothing was written.
        if (!isPoolSeedConflict(error)) throw error;
      }
      if (seeded === undefined) {
        poolAccount = "skipped: differs";
        log({ event: "migrator_pool_account", decision: poolAccount, accountSuffix: suffix });
      } else {
        poolAccount = seeded.accountCreated ? "inserted" : "skipped: exists";
        log({
          event: "migrator_pool_account",
          decision: poolAccount,
          accountSuffix: suffix,
          cellsCreated: seeded.cellsCreated,
        });
      }
    }

    const report: MigratorReport = {
      rolesCreated: roles.created,
      rolesEnabled: roles.enabled,
      rolesUnchanged: roles.unchanged,
      migrationsApplied: after - before,
      systemAccountsCreated: accounts.created,
      firstAdmin,
      poolAccount,
    };
    log({ event: "migrator_done", ...report });
    return report;
    /* eslint-disable preserve-caught-error -- the cause is dropped on purpose (R14), see below */
  } catch (error) {
    // The cause is dropped on purpose: a driver message can carry the URL or a statement (R14).
    // Only the PostgreSQL SQLSTATE is kept (five letters or digits, a class of error, never data), so a
    // failed deploy can be told apart without a database path (R2; staging deploy of 2026-11-14).
    const sqlstate = sqlstateOf(error);
    if (refused) {
      log({ event: "migrator_refused", reason: "no_tls" });
      throw new Error("migrator: the connection is not encrypted");
    }
    if (step === "verify" && changed > 0) {
      log({ event: "migrator_refused", reason: "migration_changed", count: changed });
      throw new Error("migrator: an applied migration changed");
    }
    log({ event: "migrator_failed", step, ...(sqlstate === undefined ? {} : { sqlstate }) });
    if (step === "connect") throw new Error("migrator: could not connect");
    if (step === "tls") throw new Error("migrator: could not check the connection");
    if (step === "roles") throw new Error("migrator: could not prepare the roles");
    if (step === "verify") throw new Error("migrator: could not check the applied migrations");
    if (step === "accounts") throw new Error("migrator: could not prepare the ledger accounts");
    if (step === "first_admin") throw new Error("migrator: could not bootstrap the first admin");
    if (step === "pool_account") throw new Error("migrator: could not register the pool account");
    throw new Error("migrator: the migrations failed");
    /* eslint-enable preserve-caught-error */
  } finally {
    await client?.end().catch(() => undefined);
  }
}

// The SQLSTATE of a pg error, directly or as the cause of a wrapping error (drizzle wraps the driver error).
export function sqlstateOf(error: unknown): string | undefined {
  for (
    let e: unknown = error, depth = 0;
    e !== null && typeof e === "object" && depth < 3;
    depth++
  ) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
