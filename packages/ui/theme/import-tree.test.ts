import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildImportTree } from "./import-tree.ts";
import { MOCKUP_ASSETS, THEME_MANIFEST, type ThemeManifest } from "./manifest.ts";
import { ThemeError, treeDigest } from "./tree.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>`;
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const failure = (action: () => unknown): ThemeError => {
  try {
    action();
  } catch (error) {
    if (error instanceof ThemeError) return error;
    throw error;
  }
  throw new Error("expected a ThemeError");
};
const GOOD = {
  "css/a.css": "a{background:url(../img/ok.svg)} b{background:url(../img/gone.png)}",
  "img/ok.svg": SVG,
  "fonts/svg/inline.svg": SVG,
  "js/evil.js": "alert(1)",
};
const MINI: ThemeManifest = {
  shipped: [
    { cell: 0, pattern: "css/*.css" },
    { cell: 1, pattern: "img/ok.svg" },
    { cell: 2, pattern: "fonts/svg/*.svg", only: ["fonts/svg/inline.svg"], inline: true },
  ],
  neverShipped: [{ cell: 0, token: "img/topbanner*.jpg" }],
  knownMissing: ["img/gone.png"],
  unshippedFallbacks: [],
};

describe("buildImportTree on a small tree", () => {
  it("returns the allowed files sorted, with hash, size and the inline mark, and a digest", () => {
    const { tree, refs } = buildImportTree(fixture(GOOD), MINI);
    expect(tree.files.map((f) => [f.path, f.bytes, f.inline])).toEqual([
      ["css/a.css", GOOD["css/a.css"].length, false],
      ["fonts/svg/inline.svg", SVG.length, true],
      ["img/ok.svg", SVG.length, false],
    ]);
    expect(tree.files[2]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tree.digest).toBe(treeDigest(tree.files));
    expect(refs).toMatchObject({ shipped: 1, knownMissing: ["img/gone.png"] });
  });

  it("refuses a pattern that matches no file", () => {
    const manifest = { ...MINI, shipped: [...MINI.shipped, { cell: 3, pattern: "css/none.css" }] };
    const error = failure(() => buildImportTree(fixture(GOOD), manifest));
    expect([error.code, error.details]).toEqual(["pattern_unmatched", ["css/none.css"]]);
  });

  it("refuses a listed file that the source lacks or that its pattern does not allow", () => {
    const only = ["fonts/svg/inline.svg", "fonts/svg/absent.svg", "img/ok.svg"];
    const manifest = {
      ...MINI,
      shipped: [{ cell: 2, pattern: "fonts/svg/*.svg", only, inline: true as const }],
    };
    const error = failure(() => buildImportTree(fixture(GOOD), manifest));
    expect([error.code, error.details]).toEqual([
      "pattern_mismatch",
      ["fonts/svg/absent.svg: not in the source", "img/ok.svg: not matched by fonts/svg/*.svg"],
    ]);
  });

  it("Review Focus 4: a pattern that is too broad cannot pull in a script", () => {
    const root = fixture({ ...GOOD, "fonts/fa/js/all.min.js": "x", "fonts/fa/css/all.css": "a{}" });
    const error = failure(() =>
      buildImportTree(root, { ...MINI, shipped: [{ cell: 4, pattern: "fonts/**" }] }),
    );
    expect([error.code, error.details]).toEqual([
      "forbidden_file",
      ["fonts/fa/js/all.min.js: a .js file (U2)"],
    ]);
    expect(error.message).toBe("the allow-list gives a file that must never be shipped");
  });

  it("refuses a script even when the never-shipped list is empty, and a file of the list", () => {
    const script = { ...MINI, neverShipped: [], shipped: [{ cell: 0, pattern: "js/*.js" }] };
    expect(failure(() => buildImportTree(fixture(GOOD), script)).code).toBe("forbidden_file");
    const root = fixture({ ...GOOD, "img/topbanner01.jpg": "jpg" });
    const banner = { ...MINI, shipped: [{ cell: 0, pattern: "img/topbanner*.jpg" }] };
    expect(failure(() => buildImportTree(root, banner)).details).toEqual([
      "img/topbanner01.jpg: on the never-shipped list: img/topbanner*.jpg",
    ]);
  });

  it("refuses a symbolic link, a missing folder and an unsafe SVG", () => {
    const root = fixture(GOOD);
    symlinkSync(join(root, "img/ok.svg"), join(root, "img/link.svg"));
    expect(failure(() => buildImportTree(root, MINI)).code).toBe("symlink");
    expect(failure(() => buildImportTree(join(fixture({}), "nope"), MINI)).code).toBe(
      "missing_input",
    );
    const unsafe = failure(() =>
      buildImportTree(fixture({ ...GOOD, "img/ok.svg": `<svg onload="x()"/>` }), MINI),
    );
    expect([unsafe.code, unsafe.details]).toEqual([
      "unsafe_svg",
      ["img/ok.svg: contains an event handler attribute"],
    ]);
  });

  it("refuses a stylesheet reference that is in no class", () => {
    const css = "a{background:url(../img/unknown.png)}";
    const error = failure(() => buildImportTree(fixture({ ...GOOD, "css/a.css": css }), MINI));
    expect([error.code, error.details]).toEqual(["unclassified_reference", ["img/unknown.png"]]);
  });
});

describe("buildImportTree on the real mockup (Antler 4.5.0)", () => {
  const { tree, refs } = buildImportTree(`${repoRoot}${MOCKUP_ASSETS}`, THEME_MANIFEST);
  const count = (prefix: string): number =>
    tree.files.filter((f) => f.path.startsWith(prefix)).length;

  it("gives the 55 files of 16.3, 2416190 bytes, and nothing inline yet", () => {
    expect(tree.files).toHaveLength(55);
    expect([count("apps/"), count("patterns/"), count("img/filter/")]).toEqual([26, 8, 3]);
    expect([
      count("fonts/cloudicon/"),
      count("fonts/evafeat/"),
      count("fonts/fontawesome/webfonts/"),
    ]).toEqual([5, 4, 4]);
    expect(tree.files.reduce((sum, f) => sum + f.bytes, 0)).toBe(2416190);
    expect(tree.files.some((f) => f.inline)).toBe(false);
    expect(tree.files.every((f) => !/\.(js|php|mjs|cjs|map|tpl)$/.test(f.path))).toBe(true);
  });

  it("sorts every reference of the shipped stylesheets into the classes of 16.3", () => {
    expect(refs.knownMissing).toEqual([
      "fonts/evafeat/evafeat.svg",
      "img/arrow-left-2-act.png",
      "img/arrow-left-2.png",
      "img/arrow-right-2.png",
    ]);
    expect(refs.unshippedFallbacks).toEqual([
      "fonts/fontawesome/webfonts/fa-brands-400.ttf",
      "fonts/fontawesome/webfonts/fa-regular-400.ttf",
      "fonts/fontawesome/webfonts/fa-solid-900.ttf",
      "fonts/fontawesome/webfonts/fa-v4compatibility.ttf",
    ]);
    expect(refs.neverShipped).toHaveLength(27);
    expect(refs.neverShipped.filter((p) => p.startsWith("img/topbanner"))).toHaveLength(19);
    expect(refs.neverShipped.filter((p) => p.startsWith("img/partners/"))).toHaveLength(8);
    expect(refs.shipped).toBe(21);
  });

  it("is deterministic: the same digest on a second build", () => {
    expect(buildImportTree(`${repoRoot}${MOCKUP_ASSETS}`, THEME_MANIFEST).tree.digest).toBe(
      tree.digest,
    );
    expect(tree.digest).toBe("1844c80660978d5a5168b8906b07321d47d720f6196c01b4d1d32b875f3c962b");
  });
});
