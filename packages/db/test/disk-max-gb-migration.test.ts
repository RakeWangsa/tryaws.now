import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../migrate";

// WPU-Z19 (verify review 2026-11-13, packages/aws/adapters/disk.ts:42): the largest Lightsail block storage disk is
// 16,000 GB (the Lightsail quotas page), not 16,384. Migration 0028 lowers `specs.maxGb` of the `disk` anchor rows
// that 0008 and 0009 seeded; those two are not edited (forward-only). Checked here without a database; the value
// after every migration is proven against PostgreSQL by disk-anchor.test.ts.

const TAG = "0028_disk_max_gb_16000";
const read = (name: string): string => readFileSync(`${MIGRATIONS_FOLDER}/${name}`, "utf8");
const statements = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:-->\s*statement-breakpoint)?/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");

describe("migration 0028: the disk maximum is 16,000 GB", () => {
  it("is the entry of the journal right after 0027, with a newer time", () => {
    expect(existsSync(`${MIGRATIONS_FOLDER}/${TAG}.sql`)).toBe(true);
    const journal = JSON.parse(read("meta/_journal.json")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = journal.entries[at];
    const before = journal.entries[at - 1];
    expect(before?.tag).toBe("0027_support_thread");
    expect(entry?.idx).toBe((before?.idx ?? -2) + 1);
    expect(entry?.when).toBeGreaterThan(before?.when ?? Number.POSITIVE_INFINITY);
  });

  it("changes no schema: its snapshot is the child of 0027 with the same tables", () => {
    const parent = JSON.parse(read("meta/0027_snapshot.json")) as Record<string, unknown>;
    const child = JSON.parse(read("meta/0028_snapshot.json")) as Record<string, unknown>;
    expect(child["prevId"]).toBe(parent["id"]);
    expect(child["id"]).not.toBe(parent["id"]);
    const strip = (snapshot: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(snapshot).filter(([k]) => k !== "id" && k !== "prevId"));
    expect(strip(child)).toEqual(strip(parent));
  });

  it("is one UPDATE of the disk anchor rows that lowers only a maxGb above 16000", () => {
    const list = statements(read(`${TAG}.sql`));
    expect(list).toEqual([
      "UPDATE catalog_products SET specs = jsonb_set(specs, '{maxGb}', '16000'::jsonb) WHERE family = 'disk' AND aws_id = 'block-storage-gb' AND jsonb_typeof(specs->'maxGb') = 'number' AND (specs->>'maxGb')::numeric > 16000",
    ]);
    // Migrations 0008 and 0009 keep their text (forward-only).
    expect(read("0008_disk_anchor.sql")).toContain('"maxGb":16384');
    expect(read("0009_disk_anchor_us_east_1.sql")).toContain('"maxGb":16384');
  });
});
