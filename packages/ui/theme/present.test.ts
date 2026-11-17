import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { knownClasses } from "../test/class-inventory.ts";
import { VENDORED_ASSETS } from "./manifest.ts";
import {
  MOCKUP_TEMPLATE,
  THEME_ABSENT,
  antlerThemePresent,
  mockupPresent,
  vendoredThemePresent,
} from "./present.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function root(...folders: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "present-"));
  made.push(dir);
  for (const folder of folders) mkdirSync(join(dir, folder), { recursive: true });
  return dir;
}

describe("is the Antler theme in this checkout? (docs/theme.md)", () => {
  it("is not, in a folder that has neither the mockup nor the vendored copy", () => {
    const empty = root();
    expect([mockupPresent(empty), vendoredThemePresent(empty), antlerThemePresent(empty)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("asks for each folder on its own, and for both together", () => {
    const onlyMockup = root(MOCKUP_TEMPLATE);
    expect([
      mockupPresent(onlyMockup),
      vendoredThemePresent(onlyMockup),
      antlerThemePresent(onlyMockup),
    ]).toEqual([true, false, false]);
    const onlyVendored = root(VENDORED_ASSETS);
    expect([
      mockupPresent(onlyVendored),
      vendoredThemePresent(onlyVendored),
      antlerThemePresent(onlyVendored),
    ]).toEqual([false, true, false]);
    const both = root(MOCKUP_TEMPLATE, VENDORED_ASSETS);
    expect(antlerThemePresent(both)).toBe(true);
  });

  it("asks this repository when no root is given, with the same two folders", () => {
    const here = join(import.meta.dirname, "..", "..", "..");
    expect(mockupPresent()).toBe(existsSync(join(here, "design/mockup/template")));
    expect(vendoredThemePresent()).toBe(existsSync(join(here, "packages/ui/theme/assets")));
  });

  it("says where to look, in one sentence that a skipped test can carry", () => {
    expect(THEME_ABSENT).toContain("docs/theme.md");
    expect(existsSync(join(import.meta.dirname, "..", "..", "..", "docs/theme.md"))).toBe(true);
  });
});

describe("the class inventory needs the vendored theme (R16)", () => {
  it.runIf(!vendoredThemePresent())(
    "refuses to answer without it, instead of letting every class through",
    () => {
      expect(() => knownClasses()).toThrow(/Antler theme is not in this checkout/);
    },
  );

  it.runIf(vendoredThemePresent())(
    "answers with the classes of the theme, Bootstrap and tc.css",
    () => {
      const known = knownClasses();
      expect(known.has("btn")).toBe(true);
      expect(known.has("tc-skip-link")).toBe(true);
      expect(known.has("no-such-class-xyz")).toBe(false);
    },
  );
});
