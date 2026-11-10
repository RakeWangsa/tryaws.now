import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const folder = join(import.meta.dirname, "..", "migrations");
const files = readdirSync(folder).filter((name) => name.endsWith(".sql"));

it("there is at least one migration", () => {
  expect(files.length).toBeGreaterThan(0);
});
it.each(files)("%s: no name is longer than the 63 bytes PostgreSQL keeps", (name) => {
  const sql = readFileSync(join(folder, name), "utf8");
  const names = [...new Set([...sql.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""))];
  const tooLong = names.filter((id) => Buffer.byteLength(id, "utf8") > 63);
  expect(tooLong).toEqual([]);
});
