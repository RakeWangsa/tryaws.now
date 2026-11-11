import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const folder = join(import.meta.dirname, "..", "migrations");
const files = readdirSync(folder).filter((name) => name.endsWith(".sql"));

it("there is at least one migration", () => {
  expect(files.length).toBeGreaterThan(0);
});

it("namesIn finds an unquoted trigger name and an unquoted function name", () => {
  const long = "t".repeat(64);
  expect(
    namesIn(`CREATE TRIGGER ${long} BEFORE UPDATE ON x FOR EACH ROW EXECUTE FUNCTION f();`),
  ).toContain(long);
  expect(namesIn(`create or replace function ${long}() returns trigger`)).toContain(long);
});

it("namesIn finds the hand-written names of 0005_triggers.sql", () => {
  const names = namesIn(readFileSync(join(folder, "0005_triggers.sql"), "utf8"));
  expect(names).toContain("tc_check_ledger_balanced");
  expect(names).toContain("ledger_entries_balanced");
});

it.each(files)("%s: no name is longer than the 63 bytes PostgreSQL keeps", (name) => {
  const sql = readFileSync(join(folder, name), "utf8");
  const tooLong = namesIn(sql).filter((id) => Buffer.byteLength(id, "utf8") > 63);
  expect(tooLong).toEqual([]);
});

// The double-quoted names of drizzle-kit, plus the unquoted names of the hand-written migrations
// after CREATE [OR REPLACE] [CONSTRAINT] TRIGGER and CREATE [OR REPLACE] FUNCTION.
function namesIn(sql: string): string[] {
  const quoted = [...sql.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
  const unquoted = [
    ...sql.matchAll(
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:CONSTRAINT\s+)?TRIGGER|FUNCTION)\s+([A-Za-z0-9_$.]+)/gi,
    ),
  ].map((match) => match[1] ?? "");
  return [...new Set([...quoted, ...unquoted])];
}
