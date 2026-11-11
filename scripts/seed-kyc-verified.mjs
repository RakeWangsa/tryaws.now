// pnpm seed:kyc-verified -- --stage staging --email <test customer address>
// Staging only (WP2-T4). DATABASE_URL names the staging database; the stage guard runs first, before
// any connection is opened. The address is never printed (R14).
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { assertSeedStage, markKycVerified, parseArgs } from "./lib/seed-kyc-verified.mjs";

const args = parseArgs(process.argv.slice(2), process.env);
try {
  assertSeedStage(args.stage);
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("seed-kyc-verified: DATABASE_URL is not set.");
  }
  const requireFromDb = createRequire(
    fileURLToPath(new URL("../packages/db/package.json", import.meta.url)),
  );
  const pg = requireFromDb("pg");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { updated } = await markKycVerified({
      stage: args.stage,
      email: args.email,
      query: (sql, params) => pool.query(sql, params),
    });
    process.stdout.write(
      `${updated === 1 ? "1 customer marked verified." : "No customer changed."}\n`,
    );
  } finally {
    await pool.end();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "seed-kyc-verified: failed."}\n`,
  );
  process.exitCode = 1;
}
