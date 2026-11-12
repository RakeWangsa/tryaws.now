import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  baseRef,
  checkForwardOnly,
  type MigrationTree,
  readGitMigrations,
  readWorktreeMigrations,
} from "../forward-only";
import { MIGRATIONS_FOLDER } from "../migrate";

const journal = (entries: [when: number, tag: string][]) =>
  JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: entries.map(([when, tag], idx) => ({
      idx,
      version: "7",
      when,
      tag,
      breakpoints: true,
    })),
  });
// A tree from a list of files (text: the file name, unless a [path, text] pair is given) and the entries of its journal.
const tree = (
  files: (string | [path: string, text: string])[],
  entries?: [when: number, tag: string][],
): MigrationTree =>
  new Map([
    ...files.map((f): [string, string] => (typeof f === "string" ? [f, `-- ${f}`] : f)),
    ...(entries ? [["meta/_journal.json", journal(entries)] as [string, string]] : []),
  ]);

const committed = ["0000_catalog.sql", "meta/0000_snapshot.json"];
const base = tree(committed, [[1000, "0000_catalog"]]);

it("clean case: the committed migrations unchanged plus a newer one", () => {
  const current = tree(
    [...committed, "0001_identity.sql", "meta/0001_snapshot.json"],
    [
      [1000, "0000_catalog"],
      [2000, "0001_identity"],
    ],
  );
  expect(checkForwardOnly(base, current)).toEqual([]);
});

it("a changed committed migration", () => {
  const current = tree(
    [["0000_catalog.sql", "-- 0000_catalog.sql edited"], "meta/0000_snapshot.json"],
    [[1000, "0000_catalog"]],
  );
  expect(checkForwardOnly(base, current)).toEqual(["0000_catalog.sql was changed"]);
});

it("a deleted committed migration", () => {
  expect(checkForwardOnly(base, tree(["0000_catalog.sql"], [[1000, "0000_catalog"]]))).toEqual([
    "meta/0000_snapshot.json was deleted",
  ]);
});

it("a new migration with an older timestamp than the last one", () => {
  const current = tree(
    [...committed, "0001_x.sql"],
    [
      [1000, "0000_catalog"],
      [900, "0001_x"],
    ],
  );
  expect(checkForwardOnly(base, current)).toEqual([
    "meta/_journal.json entry 1 is not newer than entry 0",
  ]);
});

it("an edited journal entry, and a deleted journal", () => {
  expect(checkForwardOnly(base, tree(committed, [[999, "0000_catalog"]]))).toEqual([
    "meta/_journal.json entry 0 was changed",
  ]);
  expect(checkForwardOnly(base, tree(committed))).toEqual(["meta/_journal.json was deleted"]);
});

it("a removed journal entry, and two entries with the same timestamp", () => {
  const files = [...committed, "0001_identity.sql"];
  const two = tree(files, [
    [1000, "0000_catalog"],
    [2000, "0001_identity"],
  ]);
  expect(checkForwardOnly(two, tree(files, [[1000, "0000_catalog"]]))).toEqual([
    "meta/_journal.json entry 1 was removed",
    "0001_identity.sql has no journal entry",
  ]);
  expect(
    checkForwardOnly(
      base,
      tree(
        [...committed, "0001_x.sql"],
        [
          [1000, "0000_catalog"],
          [1000, "0001_x"],
        ],
      ),
    ),
  ).toEqual(["meta/_journal.json entry 1 is not newer than entry 0"]);
});

it("an SQL file that the journal does not name would never run", () => {
  expect(
    checkForwardOnly(base, tree([...committed, "0001_orphan.sql"], [[1000, "0000_catalog"]])),
  ).toEqual(["0001_orphan.sql has no journal entry"]);
});

it("a journal that is not valid JSON is refused with a clear message", () => {
  const broken: MigrationTree = new Map([
    ["0000_catalog.sql", "-- 0000_catalog.sql"],
    ["meta/0000_snapshot.json", "-- meta/0000_snapshot.json"],
    ["meta/_journal.json", "{ not json"],
  ]);
  const message = "forward-only check: meta/_journal.json is not valid JSON";
  expect(() => checkForwardOnly(tree([]), broken)).toThrow(message);
  expect(() => checkForwardOnly(broken, base)).toThrow(message);
});

it.each([
  "null",
  "[]",
  '{"entries": 5}',
  '{"entries": [null]}',
  '{"entries": [{"when": "1", "tag": "0000_x"}]}',
  '{"entries": [{"when": 1}]}',
])("a journal of the wrong shape is refused with a clear message: %s", (text) => {
  const current: MigrationTree = new Map([
    ["0000_x.sql", "-- 0000_x.sql"],
    ["meta/_journal.json", text],
  ]);
  expect(() => checkForwardOnly(tree([]), current)).toThrow(
    "forward-only check: meta/_journal.json has the wrong shape",
  );
});

it("checks the order and the files of the journal even when the base is empty", () => {
  const empty = tree([]);
  expect(
    checkForwardOnly(
      empty,
      tree(
        ["0000_a.sql", "0001_b.sql"],
        [
          [2000, "0000_a"],
          [1000, "0001_b"],
        ],
      ),
    ),
  ).toEqual(["meta/_journal.json entry 1 is not newer than entry 0"]);
  expect(checkForwardOnly(empty, tree([], [[1000, "0000_a"]]))).toEqual([
    "meta/_journal.json entry 0 has no 0000_a.sql",
  ]);
});

it("in the folder layout, a new migration must sort last", () => {
  const b = tree(["20261111120000_catalog/migration.sql"]);
  expect(
    checkForwardOnly(
      b,
      tree(["20261111120000_catalog/migration.sql", "20261111130000_identity/migration.sql"]),
    ),
  ).toEqual([]);
  expect(
    checkForwardOnly(
      b,
      tree(["20261111120000_catalog/migration.sql", "20261110000000_early/migration.sql"]),
    ),
  ).toEqual(["20261110000000_early sorts before an existing migration"]);
});

// WPU-B4 (audit item 17): a merge that puts a migration before a committed one renumbers the idx of
// the committed entries. That is not an edit; an edit of an entry, or of its SQL file, still is.
describe("a journal renumbered by a merge", () => {
  const baseTwo = tree(
    ["0000_catalog.sql", "0001_late.sql"],
    [
      [1000, "0000_catalog"],
      [3000, "0001_late"],
    ],
  );
  const files = ["0000_catalog.sql", "0001_middle.sql"];

  it("is clean when a committed entry only moves to a later idx", () => {
    const merged = tree(
      [...files, "0001_late.sql"],
      [
        [1000, "0000_catalog"],
        [2000, "0001_middle"],
        [3000, "0001_late"],
      ],
    );
    expect(checkForwardOnly(baseTwo, merged)).toEqual([]);
  });

  it("still rejects an edited SQL file", () => {
    const merged = tree(
      [...files, ["0001_late.sql", "-- 0001_late.sql edited"]],
      [
        [1000, "0000_catalog"],
        [2000, "0001_middle"],
        [3000, "0001_late"],
      ],
    );
    expect(checkForwardOnly(baseTwo, merged)).toEqual(["0001_late.sql was changed"]);
  });

  it("still rejects an edited entry", () => {
    const merged = tree(
      [...files, "0001_late.sql"],
      [
        [1000, "0000_catalog"],
        [2000, "0001_middle"],
        [3500, "0001_late"],
      ],
    );
    expect(checkForwardOnly(baseTwo, merged)).toEqual(["meta/_journal.json entry 1 was changed"]);
  });

  it("still rejects a removed entry", () => {
    const merged = tree(
      [...files, "0001_late.sql"],
      [
        [1000, "0000_catalog"],
        [2000, "0001_middle"],
      ],
    );
    expect(checkForwardOnly(baseTwo, merged)).toEqual([
      "meta/_journal.json entry 1 was removed",
      "0001_late.sql has no journal entry",
    ]);
  });
});

it("the migrations of this branch pass against the base branch (while main has no migration, only rule 3 runs)", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const ref = baseRef(repo);
  expect(
    checkForwardOnly(readGitMigrations(ref, repo), readWorktreeMigrations(MIGRATIONS_FOLDER)),
  ).toEqual([]);
});
