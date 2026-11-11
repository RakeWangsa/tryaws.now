// node scripts/seed-wallet-smoke.ts
// Seeds the LOCAL database for the wallet smoke (WP3-T4 Task 8): an active market with known limits and
// quick amounts, the platform ledger accounts, one verified customer with an empty wallet for each
// Playwright project, and a third customer with one open payment. Prints one JSON line with the
// subjects and the id of that payment. Refuses a database that is not local (R3). `pg` is resolved
// from packages/db, because the root of the repository does not depend on it.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { isLocalDatabaseUrl, LOCAL_DATABASE_URL, seedSql } from "./lib/wallet-smoke.mjs";

const url =
  process.env["DATABASE_URL"] === undefined || process.env["DATABASE_URL"] === ""
    ? LOCAL_DATABASE_URL
    : process.env["DATABASE_URL"];
if (!isLocalDatabaseUrl(url)) {
  process.stderr.write("seed-wallet-smoke: refused: DATABASE_URL is not a local address\n");
  process.exit(1);
}
const stage = process.env["TC_STAGE"];
if (stage === "staging" || stage === "production") {
  process.stderr.write("seed-wallet-smoke: refused: TC_STAGE is staging or production\n");
  process.exit(1);
}

const requireFromDb = createRequire(resolve(import.meta.dirname, "../packages/db/package.json"));
const pg = requireFromDb("pg");
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
const statements = seedSql();
try {
  await client.connect();
  await client.query("begin");
  for (const statement of statements) await client.query(statement.text, statement.values);
  await client.query("commit");
  process.stdout.write(
    `${JSON.stringify({ subs: statements.subs, otherPaymentId: statements.otherPaymentId })}\n`,
  );
} catch (error) {
  await client.query("rollback").catch(() => {});
  // The error text can hold the connection string; print its code only (R14).
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : "?";
  process.stderr.write(`seed-wallet-smoke: failed (${String(code)})\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
