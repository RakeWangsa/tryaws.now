import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { MANUAL_PROOFS } from "../../verify/manual-proofs.mjs";
import { SECTION15 } from "../../verify/section15.mjs";

// WPU-B4 (audit item 31). docs/spec/15 is read, never edited.
const root = resolve(import.meta.dirname, "../..");
const items = readFileSync(resolve(root, "docs/spec/15-security-gate-before-launch.md"), "utf8")
  .split("\n")
  .filter((line) => line.startsWith("- [ ] "))
  .map((line) => line.slice("- [ ] ".length));

it("every item of Section 15 has exactly one entry in the map, in the order of the spec", () => {
  expect(items.length).toBeGreaterThan(0);
  expect(SECTION15).toHaveLength(items.length);
  items.forEach((item, i) => {
    expect(item.startsWith(SECTION15[i].start), `item ${i + 1}: ${item.slice(0, 60)}`).toBe(true);
  });
});

it("every file that proves an item exists and is a test", () => {
  for (const entry of SECTION15) {
    expect(entry.local.length, entry.start).toBeGreaterThan(0);
    for (const file of entry.local) {
      expect(existsSync(resolve(root, file)), file).toBe(true);
      expect(/\.test\.(ts|tsx|mjs)$/.test(file), file).toBe(true);
    }
  }
});

it("every manual half names a proof of verify/manual-proofs.mjs", () => {
  for (const entry of SECTION15)
    for (const id of entry.manual ?? []) expect(Object.hasOwn(MANUAL_PROOFS, id), id).toBe(true);
});

it("the evidence of WP9-T1 stays a person's proof, never a pass of this map", () => {
  expect(MANUAL_PROOFS["wp9-t1-section15-evidence"].task).toBe("WP9-T1");
});
