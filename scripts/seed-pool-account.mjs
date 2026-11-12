// pnpm seed:pool-account -- --stage staging --aws-account-id <12 digits> --external-id <value> --name <alias>
//   [--tier new|trusted] [--role-arn <arn>] [--limits '{"instance_vcpu":40}'] [--confirm-production]
// WPU-G1. Registers the single pool account and seeds pool_capacity for every quota code in the three
// launch Regions. Idempotent; it never changes a row that exists. DATABASE_URL names the database and
// must be the table owner (no application role may write these tables). The checks and the SQL are in
// packages/db/seed-pool.ts. Nothing here reads or prints a credential. Run it from a trusted machine
// through the migrator path; the document is docs/runbooks/pool-account-single.md.
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { parseSeedArgs, planPoolSeed, seedPoolAccount } from "../packages/db/seed-pool.ts";

try {
  const input = parseSeedArgs(process.argv.slice(2), process.env);
  // The stage guard and every field check run before a connection is opened.
  planPoolSeed(input);
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("seed-pool: DATABASE_URL is not set.");
  }
  const requireFromDb = createRequire(
    fileURLToPath(new URL("../packages/db/package.json", import.meta.url)),
  );
  const pg = requireFromDb("pg");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const result = await seedPoolAccount((sql, params) => client.query(sql, params), input);
      process.stdout.write(
        `pool account ${result.accountCreated ? "registered" : "already registered"}; ` +
          `${result.cellsCreated} capacity rows added, ${result.cellsExisting} already there.\n`,
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "seed-pool: failed."}\n`);
  process.exitCode = 1;
}
