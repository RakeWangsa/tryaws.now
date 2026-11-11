// node scripts/seed-auth-smoke.mjs [--check-only]
// WP2-T2 Task 10: prepares the LOCAL database for the sign-in smoke and nothing else. It refuses a
// database that is not on this machine. The customer is created by the sign-up under test, so only the
// market the sign-up needs is written: BD, active (the sign-up reads it and refuses a closed market),
// the same row that seedLaunchData writes for staging. It also empties rate_limits, so that the limits
// of an earlier run (five sign-ups an hour from one address) do not fail this one.
//
// Why raw SQL and not seedLaunchData: Node runs this file with its own type stripping, and the files of
// packages/db import each other without an extension, which Node cannot resolve. The row and its
// columns are those of seedLaunchData (LAUNCH_MARKET); a change there needs a change here.
// Exit codes: 0 done, 2 the database cannot be reached or is not migrated (BLOCKED), 1 anything else.
import { createRequire } from "node:module";
import { isLocalDatabaseUrl } from "./lib/auth-smoke.mjs";

const LOCAL_URL = "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud";
const url =
  process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== ""
    ? process.env.DATABASE_URL
    : LOCAL_URL;
const checkOnly = process.argv.includes("--check-only");
const say = (line) => process.stdout.write(`${line}\n`);

if (!isLocalDatabaseUrl(url)) {
  say("seed-auth-smoke: refuses a database that is not on this machine");
  process.exit(1);
}

// pg is a dependency of packages/db, not of the root: resolve it from there.
const requireFromDb = createRequire(
  new globalThis.URL("../packages/db/package.json", import.meta.url),
);
const pg = requireFromDb("pg");
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });

try {
  await client.connect();
} catch {
  say("seed-auth-smoke: the local database does not answer");
  process.exit(2);
}

try {
  const migrated = await client.query(
    "select to_regclass('public.markets') as markets, to_regclass('public.rate_limits') as limits",
  );
  if (migrated.rows[0]?.markets === null || migrated.rows[0]?.limits === null) {
    say("seed-auth-smoke: the local database is not migrated");
    process.exit(2);
  }
  if (checkOnly) {
    say("seed-auth-smoke: the local database answers and is migrated");
    process.exit(0);
  }
  await client.query(
    `insert into markets (id, code, currency, gateway, locales, numerals, topup_min_minor, topup_max_minor, active)
     values (gen_random_uuid(), 'BD', 'BDT', 'eps', '{bn,en}', 'beng', 10000, 5000000, true)
     on conflict (code) do nothing`,
  );
  const opened = await client.query("update markets set active = true where code = 'BD'");
  const cleared = await client.query("delete from rate_limits");
  say(
    `seed-auth-smoke: market BD active (${opened.rowCount} row), ${cleared.rowCount} limiter rows cleared`,
  );
} catch {
  say("seed-auth-smoke: the seed failed");
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
