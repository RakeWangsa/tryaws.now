import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refKind, resolveRef, scanCssRefs } from "./css-refs.ts";
import { listFiles, matchPattern } from "./glob.ts";
import {
  INLINE_SVGS,
  MOCKUP_ASSETS,
  TC_FONTS,
  THEME_MANIFEST,
  forbiddenReason,
  neverPattern,
} from "./manifest.ts";
import { mockupPresent } from "./present.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const assets = `${repoRoot}${MOCKUP_ASSETS}`;
// Empty without the paid mockup (a public checkout); the suites that read it skip (docs/theme.md).
const mockupFiles = mockupPresent() ? listFiles(assets) : [];
const baseline = JSON.parse(readFileSync(`${repoRoot}verify/baseline.json`, "utf8")) as {
  theme: { shipped: string[]; neverShipped: string[] };
};
const ticks = (cell: string | undefined): string[] =>
  [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
const sorted = (list: readonly string[]): string[] => [...list].sort();
const expand = (pattern: string): string[] => mockupFiles.filter((f) => matchPattern(pattern, f));
const given = (): string[] =>
  THEME_MANIFEST.shipped.flatMap((row) =>
    expand(row.pattern).filter((f) => row.only === undefined || row.only.includes(f)),
  );

describe("the manifest follows the tables of 16.3 in verify/baseline.json", () => {
  it("has a row for every pattern of each of the 8 shipped cells, and no other", () => {
    expect(baseline.theme.shipped).toHaveLength(8);
    baseline.theme.shipped.forEach((cell, index) => {
      const rows = THEME_MANIFEST.shipped.filter((r) => r.cell === index).map((r) => r.pattern);
      expect(sorted(rows), `cell ${index}: ${cell}`).toEqual(sorted(ticks(cell)));
    });
  });

  it("has a row for every token of each of the 5 never-shipped cells, and one row of its own", () => {
    expect(baseline.theme.neverShipped).toHaveLength(5);
    baseline.theme.neverShipped.forEach((cell, index) => {
      const rows = THEME_MANIFEST.neverShipped.filter((r) => r.cell === index).map((r) => r.token);
      expect(sorted(rows), `cell ${index}: ${cell}`).toEqual(sorted(ticks(cell)));
    });
    expect(THEME_MANIFEST.neverShipped.filter((r) => r.cell === null).map((r) => r.token)).toEqual([
      "fonts/fontawesome/js/*",
    ]);
  });
});

describe.skipIf(!mockupPresent())("the manifest against the mockup (Antler 4.5.0)", () => {
  it("holds the 26 app logos and the 306 line illustrations that 16.3 counts", () => {
    expect(expand("apps/*.svg")).toHaveLength(26);
    expect(expand("fonts/svg/*.svg")).toHaveLength(306);
  });

  it("lists as `only` exactly the 8 pattern files that theme.min.css refers to", () => {
    const row = THEME_MANIFEST.shipped.find((r) => r.pattern === "patterns/*.svg");
    const css = readFileSync(`${assets}/css/theme.min.css`, "utf8");
    const referred = scanCssRefs(css)
      .map((r) => resolveRef("assets/css/theme.min.css", r.raw))
      .filter((p): p is string => p !== null && p.startsWith("assets/patterns/"))
      .map((p) => p.slice("assets/".length));
    expect(sorted([...new Set(referred)])).toEqual(sorted(row?.only ?? []));
    expect(row?.only).toHaveLength(8);
    for (const file of row?.only ?? []) expect(mockupFiles, file).toContain(file);
  });

  it("gives 55 files, and none of them is forbidden (Review Focus 4: a glob must not pull in a script)", () => {
    expect(given()).toHaveLength(55);
    expect(given().filter((f) => forbiddenReason(f) !== null)).toEqual([]);
    for (const row of THEME_MANIFEST.shipped) {
      const hits = expand(row.pattern).filter(
        (f) => row.only === undefined || row.only.includes(f),
      );
      if (row.only?.length === 0) expect(hits, row.pattern).toEqual([]);
      else expect(hits.length, row.pattern).toBeGreaterThan(0);
    }
    for (const name of INLINE_SVGS) expect(matchPattern("fonts/svg/*.svg", name), name).toBe(true);
  });

  it("the known missing files are still missing and the unshipped fallbacks are still there", () => {
    for (const file of THEME_MANIFEST.knownMissing) expect(mockupFiles, file).not.toContain(file);
    for (const file of THEME_MANIFEST.unshippedFallbacks) expect(mockupFiles, file).toContain(file);
  });

  it("no shipped stylesheet has an @import, and they name no file outside the three classes, except the unshipped fallbacks", () => {
    const shipped = new Set(given());
    const unknown = new Set<string>();
    for (const css of [...shipped].filter((f) => f.endsWith(".css"))) {
      for (const ref of scanCssRefs(readFileSync(join(assets, css), "utf8"))) {
        // 16.1: the shipped CSS has no @import; one would change the load order that 16.3 fixes
        expect(ref.kind, `${css}: @import ${ref.raw}`).toBe("url");
        if (refKind(ref.raw) === "data") continue;
        expect(refKind(ref.raw), `${css}: ${ref.raw}`).toBe("relative");
        const target = resolveRef(`assets/${css}`, ref.raw);
        const inAssets = target?.startsWith("assets/") ? target.slice("assets/".length) : null;
        if (inAssets === null) unknown.add(`${css}: ${ref.raw}`);
        else if (
          !shipped.has(inAssets) &&
          forbiddenReason(inAssets) === null &&
          !THEME_MANIFEST.knownMissing.includes(inAssets)
        )
          unknown.add(inAssets);
      }
    }
    expect(sorted([...unknown])).toEqual(sorted(THEME_MANIFEST.unshippedFallbacks));
  });
});

describe("neverPattern and forbiddenReason", () => {
  it.each([
    ["js/*", "js/**"],
    ["php/*", "php/**"],
    ["locales/*", "locales/**"],
    ["img/partners/*", "img/partners/**"],
    ["css/rtl/*", "css/rtl/**"],
    ["fonts/fontawesome/js/*", "fonts/fontawesome/js/**"],
    ["order-form/", "order-form/**"],
    ["css/aos.min.css", "css/aos.min.css"],
    ["img/topbanner*.jpg", "img/topbanner*.jpg"],
  ])("neverPattern(%s) is %s", (token, pattern) => {
    expect(neverPattern(token)).toBe(pattern);
  });

  it.each([
    ["js/jquery.min.js", /a \.js file/],
    ["fonts/fontawesome/js/all.min.js", /a \.js file/],
    ["JS/X.JS", /a \.js file/],
    ["php/form-process.php", /a \.php file/],
    ["fonts/svg/a.map", /a \.map file/],
    ["order-form/antler/style.css", /under order-form\//],
    ["img/topbanner01.jpg", /never-shipped list: img\/topbanner\*\.jpg/],
    ["img/partners/envato.svg", /never-shipped list: img\/partners\/\*/],
    ["img/logo.svg", /never-shipped list: img\/logo\.svg/],
    ["css/rtl/theme-rtl.min.css", /never-shipped list: css\/rtl\/\*/],
    ["locales/en/translations.json", /never-shipped list: locales\/\*/],
    ["css/theme.min.css", null],
    ["apps/ubuntu.svg", null],
    ["img/filter/cd-icon-check.svg", null],
    ["fonts/fontawesome/webfonts/fa-solid-900.woff2", null],
  ])("%s is refused as %s", (path, expected) => {
    const reason = forbiddenReason(path);
    if (expected === null) expect(reason).toBeNull();
    else expect(reason).toMatch(expected);
  });
});

describe("TC_FONTS (needs Task 1)", () => {
  it.each(TC_FONTS)("the pinned package $package holds the files the faces use", (font) => {
    const dir = dirname(fileURLToPath(import.meta.resolve(`${font.package}/package.json`)));
    for (const file of font.files) expect(existsSync(join(dir, "files", file)), file).toBe(true);
  });
});
