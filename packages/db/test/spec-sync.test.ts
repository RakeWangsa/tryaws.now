import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";
import { columnsOf } from "./sql";

const t = useTempDatabase();
const baselinePath = fileURLToPath(new URL("../../../verify/baseline.json", import.meta.url));
const COLUMN_TOKEN = /^[a-z][a-z0-9_]*_(minor|at|id|sub|key|seq|usd|after|status|tier)$/;
// Tables that an owner decision added after Section 7 was written, each with the decision. Section 7 of
// the plan (and so verify/baseline.json) is amended in its own pull request (docs/spec is not edited in a
// task); then the table moves to the plan and this list is empty again.
//   support_messages  the thread of a support request: owner decision 2026-11-13 round 3 (WPU-Z5)
const ADDED_BY_OWNER_DECISION: readonly string[] = ["support_messages"];

it("verify/baseline.json exists (run pnpm baseline:build)", () => {
  expect(existsSync(baselinePath), `missing ${baselinePath}`).toBe(true);
});

it("the database has exactly the 37 tables of section 7 and the tables of owner decisions, and the same append-only ones", async () => {
  const spec = JSON.parse(readFileSync(baselinePath, "utf8")).tables as {
    name: string;
    appendOnly: boolean;
    columns: string;
  }[];
  const tables = (
    await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
    )
  ).rows.map((r) => r.table_name);
  // sort in JavaScript on both sides: the server's collation may order "_" differently
  expect(tables.sort()).toEqual([...spec.map((s) => s.name), ...ADDED_BY_OWNER_DECISION].sort());
  expect(spec).toHaveLength(37);
  // a table of an owner decision is not one of Section 7 (else it belongs in the plan only)
  expect(spec.map((s) => s.name).filter((n) => ADDED_BY_OWNER_DECISION.includes(n))).toEqual([]);
  const guarded = (
    await t.pool.query(
      "select c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'r5_append_only_row'",
    )
  ).rows
    .map((r) => r.relname)
    .sort();
  expect(guarded).toEqual(
    spec
      .filter((s) => s.appendOnly)
      .map((s) => s.name)
      .sort(),
  );
  expect(guarded).toHaveLength(6);
});

it("every column that section 7 names in back-ticks exists", async () => {
  const spec = JSON.parse(readFileSync(baselinePath, "utf8")).tables as {
    name: string;
    columns: string;
  }[];
  let checked = 0;
  for (const s of spec) {
    const tokens = [...s.columns.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1]!)
      .filter((x) => COLUMN_TOKEN.test(x));
    const cols = (await columnsOf(t.pool, s.name)).map((c) => c.split(" ")[0]);
    for (const token of tokens) {
      expect(cols, `${s.name}.${token}`).toContain(token);
      checked += 1;
    }
  }
  expect(checked, "column tokens found in verify/baseline.json").toBeGreaterThanOrEqual(20);
});
