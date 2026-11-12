import { describe, expect, it } from "vitest";
import {
  COUNTED_TABLES,
  EXIT,
  INVARIANTS,
  TEMP_PREFIX,
  drillGuard,
  evaluate,
  isDrillDatabase,
  oneNumber,
  urlWithDatabase,
} from "./restore-drill.mjs";
import { pgEnv, runDrill } from "./restore-drill-run.mjs";

const LOCAL = "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud";
const NAME = `${TEMP_PREFIX}0123456789ab`;

describe("drillGuard (R3: the drill touches a local database only)", () => {
  it("accepts the local database by default and by URL", () => {
    expect(drillGuard({})).toMatchObject({ ok: true });
    expect(drillGuard({ DATABASE_URL: "postgres://u:p@localhost:5432/x" })).toMatchObject({
      ok: true,
    });
  });
  it("refuses staging and production, however the stage is named", () => {
    for (const env of [
      { TC_STAGE: "staging" },
      { TC_STAGE: "production" },
      { SST_STAGE: "production" },
      { STAGE: "staging" },
    ]) {
      expect(drillGuard(env).ok, JSON.stringify(env)).toBe(false);
    }
  });
  it("refuses a host that is not this machine, and never prints the URL", () => {
    for (const url of [
      "postgres://u:secret@db.example.com:5432/x",
      "postgres://u:secret@10.0.0.5:5432/x",
      "postgres://u:secret@tc.abc.ap-southeast-1.rds.amazonaws.com/x",
      "postgres://u:secret@127.0.0.1/x?host=db.example.com",
      "not a url",
    ]) {
      const verdict = drillGuard({ DATABASE_URL: url });
      expect(verdict.ok, url).toBe(false);
      expect(JSON.stringify(verdict)).not.toContain("secret");
    }
  });
});

describe("what the drill may create and drop", () => {
  it("only names with its own prefix and twelve hex digits are drill databases", () => {
    expect(isDrillDatabase(NAME)).toBe(true);
    for (const other of [
      "ticoncloud",
      "postgres",
      `${TEMP_PREFIX}x`,
      `${TEMP_PREFIX}0123456789ab; drop`,
    ]) {
      expect(isDrillDatabase(other), other).toBe(false);
    }
  });
  it("urlWithDatabase changes the database and refuses a URL that is not local", () => {
    expect(urlWithDatabase(LOCAL, "postgres")).toBe(
      "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    );
    expect(() => urlWithDatabase("postgres://u:p@db.example.com/x", "postgres")).toThrow();
    expect(() => urlWithDatabase(LOCAL, "x; drop")).toThrow();
  });
  it("the password travels in the environment, not in an argument", () => {
    expect(pgEnv(LOCAL, "postgres")).toMatchObject({
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: "postgres",
      PGDATABASE: "postgres",
    });
  });
});

const counts = (n = 3) => Object.fromEntries(COUNTED_TABLES.map((t) => [t, n]));
const clean = () => Object.fromEntries(INVARIANTS.map((c) => [c.id, 0]));

describe("evaluate", () => {
  it("passes a copy that equals the source and holds every invariant", () => {
    const side = { counts: counts(), invariants: clean() };
    expect(evaluate({ source: side, restored: side, allowEmpty: false })).toMatchObject({
      exit: EXIT.passed,
    });
  });
  it("fails a missing row, and names the table", () => {
    const source = { counts: counts(), invariants: clean() };
    const restored = { counts: { ...counts(), ledger_entries: 2 }, invariants: clean() };
    const out = evaluate({ source, restored, allowEmpty: false });
    expect(out.exit).toBe(EXIT.failed);
    expect(out.lines.join("\n")).toContain("ledger_entries");
  });
  it("fails a broken invariant on the copy", () => {
    const source = { counts: counts(), invariants: clean() };
    const restored = { counts: counts(), invariants: { ...clean(), wallet_equals_ledger: 1 } };
    expect(evaluate({ source, restored, allowEmpty: false }).exit).toBe(EXIT.failed);
  });
  it("an empty ledger is BLOCKED, not a pass, unless the mechanics alone are asked for", () => {
    const side = { counts: counts(0), invariants: clean() };
    expect(evaluate({ source: side, restored: side, allowEmpty: false }).exit).toBe(EXIT.blocked);
    const allowed = evaluate({ source: side, restored: side, allowEmpty: true });
    expect(allowed.exit).toBe(EXIT.passed);
    expect(allowed.lines.join("\n")).toContain("mechanics only");
  });
  it("oneNumber reads one count and nothing else", () => {
    expect(oneNumber("12\n")).toBe(12);
    expect(() => oneNumber("")).toThrow();
    expect(() => oneNumber("1\n2")).toThrow();
  });
});

// A fake PostgreSQL toolset: the source holds `rows` per table, the restore copies them (or not).
function world(over = {}) {
  const calls = [];
  const state = { dropped: [], created: [], removed: false };
  const exec = (tool, args, env) => {
    calls.push({ tool, args, env });
    if (over.missing === tool) return { status: null, stdout: "" };
    if (args[0] === "--version") return { status: 0, stdout: "x" };
    if (tool === "pg_dump") return { status: over.dumpFails ? 1 : 0, stdout: "" };
    if (tool === "pg_restore") return { status: over.restoreFails ? 1 : 0, stdout: "" };
    const sql = args.at(-1);
    if (sql === "select 1") return { status: over.down ? 2 : 0, stdout: "1" };
    const create = /^create database "(.+)"$/.exec(sql);
    if (create) {
      state.created.push(create[1]);
      return { status: 0, stdout: "" };
    }
    const drop = /^drop database if exists "(.+)" with \(force\)$/.exec(sql);
    if (drop) {
      state.dropped.push(drop[1]);
      return { status: over.dropFails ? 1 : 0, stdout: "" };
    }
    const copy = env.PGDATABASE !== "ticoncloud";
    const table = /^select count\(\*\) from (\w+)$/.exec(sql);
    if (table) {
      const rows = over.rows ?? 3;
      return { status: 0, stdout: String(copy && over.lose === table[1] ? rows - 1 : rows) };
    }
    const invariant = INVARIANTS.find((c) => c.sql === sql);
    if (invariant) {
      const bad = copy && over.broken === invariant.id;
      return { status: 0, stdout: bad ? "2" : "0" };
    }
    return { status: 1, stdout: "" };
  };
  const tempDir = () => ({ path: "/tmp/x", remove: () => (state.removed = true) });
  const run = (extra = {}) =>
    runDrill({ env: {}, argv: [], exec, tempDir, name: () => NAME, ...extra });
  return { calls, state, run };
}

describe("runDrill", () => {
  it("takes a dump, restores into a temporary database, checks it and drops it", () => {
    const w = world();
    const out = w.run();
    expect(out.exit).toBe(EXIT.passed);
    expect(w.state.created).toEqual([NAME]);
    expect(w.state.dropped).toEqual([NAME]);
    expect(w.state.removed).toBe(true);
    const tools = w.calls.filter((c) => c.args[0] !== "--version").map((c) => c.tool);
    expect(tools.indexOf("pg_dump")).toBeLessThan(tools.indexOf("pg_restore"));
    // The restore ran against the copy, never the source.
    expect(
      w.calls.find((c) => c.tool === "pg_restore" && c.args[0] !== "--version").args,
    ).toContain(`--dbname=${NAME}`);
    // No password in any argument.
    expect(JSON.stringify(w.calls.map((c) => c.args))).not.toContain("postgres:postgres");
  });
  it("is BLOCKED, never a pass, when pg_dump is not installed", () => {
    for (const tool of ["pg_dump", "pg_restore", "psql"]) {
      const w = world({ missing: tool });
      const out = w.run();
      expect(out.exit).toBe(EXIT.blocked);
      expect(out.lines.join("\n")).toContain("BLOCKED");
      expect(w.state.created).toEqual([]);
    }
  });
  it("is BLOCKED when the local database is down", () => {
    expect(world({ down: true }).run().exit).toBe(EXIT.blocked);
  });
  it("refuses staging and a remote database before it runs anything", () => {
    for (const env of [
      { TC_STAGE: "production" },
      { DATABASE_URL: "postgres://u:p@db.example.com/x" },
    ]) {
      const w = world();
      const out = w.run({ env });
      expect(out.exit).toBe(EXIT.failed);
      expect(out.lines[0]).toContain("REFUSED");
      expect(w.calls).toEqual([]);
    }
  });
  it("fails a restored copy that lost a row or breaks an invariant, and still drops the copy", () => {
    for (const over of [{ lose: "ledger_entries" }, { broken: "wallet_equals_ledger" }]) {
      const w = world(over);
      expect(w.run().exit).toBe(EXIT.failed);
      expect(w.state.dropped).toEqual([NAME]);
      expect(w.state.removed).toBe(true);
    }
  });
  it("fails when the dump or the restore does not finish, and drops what it created", () => {
    expect(world({ dumpFails: true }).run().exit).toBe(EXIT.failed);
    const w = world({ restoreFails: true });
    expect(w.run().exit).toBe(EXIT.failed);
    expect(w.state.dropped).toEqual([NAME]);
  });
  it("an empty source is BLOCKED unless --allow-empty", () => {
    expect(world({ rows: 0 }).run().exit).toBe(EXIT.blocked);
    expect(world({ rows: 0 }).run({ argv: ["--allow-empty"] }).exit).toBe(EXIT.passed);
  });
  it("never drops a database that is not its own, whatever the name function returns", () => {
    const w = world();
    expect(() => w.run({ name: () => "ticoncloud" })).toThrow();
    expect(w.state.dropped).toEqual([]);
  });
});
