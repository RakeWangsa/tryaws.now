// The sequence of scripts/restore-drill.mjs (WP9-T3 b), with the programs it runs given as a parameter
// so that a test can follow every step without PostgreSQL. LOCAL only (R3): see drillGuard.
import { URL } from "node:url";
import {
  COUNTED_TABLES,
  EXIT,
  INVARIANTS,
  blocked,
  drillGuard,
  evaluate,
  isDrillDatabase,
  oneNumber,
  tempDatabaseName,
} from "./restore-drill.mjs";

/** The libpq environment of a URL: the password goes in PGPASSWORD, never in an argument or a line. */
export function pgEnv(url, database) {
  const parsed = new URL(url);
  return {
    PGHOST: parsed.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: parsed.port === "" ? "5432" : parsed.port,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database ?? parsed.pathname.replace(/^\//, ""),
    PGCONNECT_TIMEOUT: "10",
  };
}

/**
 * The drill. `exec(tool, args, env)` runs one program and returns { status, stdout } (status null when
 * it could not start); `tempDir()` makes a private directory and returns { path, remove() }.
 * Returns { exit, lines }. Every database it creates starts with the drill prefix and is dropped at the
 * end, also after a failure; nothing else is ever dropped.
 */
export function runDrill({ env, argv, exec, tempDir, name = tempDatabaseName }) {
  const lines = [];
  const say = (line) => lines.push(line);
  const done = (exit) => ({ exit, lines });
  const guard = drillGuard(env);
  if (!guard.ok) {
    say(`REFUSED: ${guard.reason}`);
    return done(EXIT.failed);
  }
  const allowEmpty = argv.includes("--allow-empty");
  const url = guard.url;
  const run = (tool, args, database) => exec(tool, args, pgEnv(url, database));

  for (const tool of ["pg_dump", "pg_restore", "psql"]) {
    const probe = exec(tool, ["--version"], {});
    if (probe.status !== 0) {
      say(
        blocked(
          `${tool} was not found on this machine; install the PostgreSQL client tools (the drill is skipped, not passed)`,
        ).line,
      );
      return done(EXIT.blocked);
    }
  }
  const query = (database, sql) => {
    const out = run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], database);
    if (out.status !== 0) throw new Error("psql failed");
    return out.stdout;
  };
  try {
    query(undefined, "select 1");
  } catch {
    say(
      blocked("the local database is not reachable; start it with `pnpm db:up && pnpm db:migrate`")
        .line,
    );
    return done(EXIT.blocked);
  }

  const measure = (database) => {
    const counts = {};
    for (const table of COUNTED_TABLES) {
      counts[table] = oneNumber(query(database, `select count(*) from ${table}`));
    }
    const invariants = {};
    for (const check of INVARIANTS) invariants[check.id] = oneNumber(query(database, check.sql));
    return { counts, invariants };
  };

  const scratch = tempDir();
  const copy = name();
  if (!isDrillDatabase(copy)) throw new Error("restore-drill: unsafe temporary database name");
  let created = false;
  try {
    let source;
    try {
      source = measure(undefined);
    } catch {
      say("FAIL the source database cannot be read (is it migrated? `pnpm db:migrate`)");
      return done(EXIT.failed);
    }
    const file = `${scratch.path}/drill.dump`;
    const dump = run(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`],
      undefined,
    );
    if (dump.status !== 0) {
      say("FAIL pg_dump did not finish");
      return done(EXIT.failed);
    }
    say("dump taken (logical, custom format)");
    query("postgres", `create database "${copy}"`);
    created = true;
    const restore = run(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${copy}`, file],
      "postgres",
    );
    if (restore.status !== 0) {
      say("FAIL pg_restore did not finish");
      return done(EXIT.failed);
    }
    say(`restored into a temporary database (${copy})`);
    const restored = measure(copy);
    const verdict = evaluate({ source, restored, allowEmpty });
    for (const line of verdict.lines ?? [verdict.line]) say(line);
    return done(verdict.exit);
  } catch {
    say("FAIL the drill stopped on an error (no detail is printed)");
    return done(EXIT.failed);
  } finally {
    if (created && isDrillDatabase(copy)) {
      try {
        query("postgres", `drop database if exists "${copy}" with (force)`);
      } catch {
        lines.push(`WARNING the temporary database ${copy} could not be dropped; drop it by hand`);
      }
    }
    scratch.remove();
  }
}
