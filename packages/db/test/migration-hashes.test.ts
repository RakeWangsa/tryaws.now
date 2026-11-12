import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, readMigrationHashes } from "../migrate";
import { useTempDatabase } from "./temp-db";

// WPU-D2 (C.14): the migrator compares the hash drizzle stored for each applied migration with the hash
// of the file. These tests pin that readMigrationHashes gives exactly the value drizzle stores.
describe("readMigrationHashes", () => {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as {
    entries: { when: number; tag: string }[];
  };

  it("returns one sha256 of the file text per journal entry, in journal order", () => {
    const hashes = readMigrationHashes();
    expect(hashes).toHaveLength(journal.entries.length);
    journal.entries.forEach((entry, index) => {
      const text = readFileSync(`${MIGRATIONS_FOLDER}/${entry.tag}.sql`, "utf8");
      expect(hashes[index]).toEqual({
        folderMillis: entry.when,
        hash: createHash("sha256").update(text).digest("hex"),
      });
    });
  });

  it("changes when a byte of a file changes (a different text gives a different hash)", () => {
    const text = readFileSync(`${MIGRATIONS_FOLDER}/${journal.entries[0]!.tag}.sql`, "utf8");
    const edited = createHash("sha256")
      .update(text + " ")
      .digest("hex");
    expect(readMigrationHashes()[0]!.hash).not.toBe(edited);
  });
});

describe("the hashes drizzle stored", () => {
  const T = useTempDatabase();

  it("are the hashes of the files, row by row", async () => {
    const { rows } = await T.pool.query(
      "select hash, created_at from drizzle.__drizzle_migrations order by created_at",
    );
    const files = readMigrationHashes();
    expect(rows).toHaveLength(files.length);
    rows.forEach((row, index) => {
      expect(row.hash).toBe(files[index]!.hash);
      expect(Number(row.created_at)).toBe(files[index]!.folderMillis);
    });
  });
});
