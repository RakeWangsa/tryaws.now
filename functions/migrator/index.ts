// migrator: invoked by the deploy (infra/stacks/workers.ts, aws.lambda.Invocation) with
// { action: "migrate" }. It is the only function that holds the master user and the five role
// passwords (3.3). This file is the only place that touches the process: environment, console, pg.
//
// VERIFY at the first staging deploy: that the `host` of the linked Postgres component accepts the
// master user (a proxy lists only the four application roles, infra/lib/functions.ts PROXY_ROLES),
// that Node trusts the certificate chain of that host for sslmode verify-full, and that MIGRATIONS_DIR
// (copyFiles of the Migrator function) holds the migrations folder next to the bundle.
import { createDatabase } from "@tc/db";
import { runMigrations } from "@tc/db/migrate";
import { readMigratorConfig } from "./config";
import { runMigrator, type MigratorReport, type MigratorDeps } from "./run";

export { runMigrator } from "./run";
export type { MigratorReport, MigratorDeps } from "./run";
export { readMigratorConfig } from "./config";

export const handler = async (event?: unknown): Promise<MigratorReport> => {
  const deps: MigratorDeps = {
    config: readMigratorConfig(process.env),
    connect: (url) => {
      const { pool } = createDatabase(url, { max: 1 });
      // A broken idle connection must not crash the process; the next statement reports it.
      pool.on("error", () => {});
      return Promise.resolve({
        query: async (sql, params) => {
          const result = await pool.query(sql, params === undefined ? undefined : [...params]);
          return { rows: result.rows as Record<string, unknown>[] };
        },
        end: () => pool.end(),
      });
    },
    migrate: runMigrations,
    log: (e) => console.log(JSON.stringify(e)),
  };
  return runMigrator(deps, event);
};
