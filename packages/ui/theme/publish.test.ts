import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { writeTree } from "./apply.ts";
import { fontPackageDir } from "./font-faces.ts";
import { listFiles } from "./glob.ts";
import {
  TC_CSS,
  TC_FONTS,
  THEME_MANIFEST,
  VENDORED_ASSETS,
  type ThemeManifest,
} from "./manifest.ts";
import { THEME_STYLESHEETS, fontPreloads } from "./public.ts";
import { buildPublishTree } from "./publish.ts";
import { scanOutput } from "./scan-output.ts";
import {
  SCRIPT_HASH_FILE,
  formatScriptList,
  readScriptList,
  scriptHashSet,
} from "./script-hashes.ts";
import { syncThemeMain } from "./sync-main.ts";
import { ThemeError, sha256Of } from "./tree.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"/>`;
const SCRIPT = `/* a theme script */ ${"x".repeat(150)}`;
const manifest: ThemeManifest = {
  shipped: [
    { cell: 0, pattern: "css/*.css" },
    { cell: 1, pattern: "img/*.svg" },
    { cell: 2, pattern: "fonts/svg/*.svg", only: ["fonts/svg/inline.svg"], inline: true },
  ],
  neverShipped: [{ cell: 0, token: "js/*" }],
  knownMissing: [],
  unshippedFallbacks: [],
};
const TC =
  '@font-face{font-family:"Open Sans";src:url("./fonts/open-sans-latin-wght-normal.woff2") format("woff2");unicode-range:U+0000-00FF}';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}
/** Fake Fontsource packages with the files that TC_FONTS names. */
function fakeFonts(): (name: string) => string {
  const base = temp("fonts-");
  for (const font of TC_FONTS) {
    write(join(base, font.id), { LICENSE: `licence of ${font.id}` });
    for (const file of font.files)
      write(join(base, font.id, "files"), { [file]: `bytes of ${file}` });
  }
  return (name) => join(base, TC_FONTS.find((f) => f.package === name)?.id ?? "unknown");
}
function miniRepo(extra: Record<string, string> = {}): string {
  const root = temp("publish-");
  write(root, {
    // the committed list of the theme's scripts; there is no design/ folder in this repository
    [SCRIPT_HASH_FILE]: formatScriptList([
      {
        path: "template/assets/js/lib.js",
        bytes: SCRIPT.length,
        sha256: sha256Of(new TextEncoder().encode(SCRIPT)),
      },
    ]),
    [`${VENDORED_ASSETS}/css/a.css`]: "a{background:url(../img/x.svg)}",
    [`${VENDORED_ASSETS}/img/x.svg`]: SVG,
    [`${VENDORED_ASSETS}/fonts/svg/inline.svg`]: SVG,
    [TC_CSS]: TC,
    ...extra,
  });
  return root;
}
const inputs = (root: string, fonts = fakeFonts()) => ({
  vendoredRoot: join(root, VENDORED_ASSETS),
  tcCssFile: join(root, TC_CSS),
  fontPackageDir: fonts,
  manifest,
});
function run(argv: string[], root: string, fonts = fakeFonts()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = syncThemeMain(argv, {
    repoRoot: root,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    manifest,
    fontPackageDir: fonts,
  });
  return { code, out, err };
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

describe("buildPublishTree", () => {
  it("gives the vendored files under assets/, tc.css, the fonts and their licences, and not the inline SVGs", () => {
    expect(buildPublishTree(inputs(miniRepo())).tree.files.map((f) => f.path)).toEqual([
      "assets/css/a.css",
      "assets/img/x.svg",
      "fonts/LICENSE-noto-sans-bengali.txt",
      "fonts/LICENSE-open-sans.txt",
      "fonts/noto-sans-bengali-bengali-wght-normal.woff2",
      "fonts/open-sans-latin-ext-wght-normal.woff2",
      "fonts/open-sans-latin-wght-normal.woff2",
      "tc.css",
    ]);
  });

  it("refuses a forbidden file in the vendored copy", () => {
    const error = failure(() =>
      buildPublishTree(inputs(miniRepo({ [`${VENDORED_ASSETS}/js/old.js`]: "x" }))),
    );
    expect([error.code, error.details]).toEqual(["forbidden_file", ["js/old.js: a .js file (U2)"]]);
  });

  it("refuses a font file that tc.css names and the publish stage does not copy", () => {
    const root = miniRepo({ [TC_CSS]: TC.replace("open-sans-latin-wght-normal", "other") });
    const error = failure(() => buildPublishTree(inputs(root)));
    expect([error.code, error.details]).toEqual(["unclassified_reference", ["fonts/other.woff2"]]);
  });

  it("refuses an installed font package that lacks a file, and a missing tc.css", () => {
    const empty = (): string => temp("fonts-");
    expect(failure(() => buildPublishTree(inputs(miniRepo(), empty))).code).toBe("missing_input");
    const root = miniRepo();
    expect(
      failure(() => buildPublishTree({ ...inputs(root), tcCssFile: join(root, "none.css") })).code,
    ).toBe("missing_input");
  });
});

describe("--stage publish on a small repository", () => {
  it("writes the same tree into both apps, and a second run writes nothing", () => {
    const root = miniRepo();
    const fonts = fakeFonts();
    const first = run(["--stage", "publish"], root, fonts);
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("publish web: 8 written, 0 removed, 0 unchanged");
    expect(first.out).toContain("publish admin: 8 written, 0 removed, 0 unchanged");
    expect(first.out).toContain("publish web: scanned 8 files, 0 findings");
    expect(existsSync(join(root, "design"))).toBe(false); // the build needs no design/
    const web = listFiles(join(root, "apps/web/public/theme"));
    expect(web).toEqual(listFiles(join(root, "apps/admin/public/theme")));
    expect(web).toContain("assets/css/a.css");
    const second = run(["--stage", "publish"], root, fonts);
    expect(second.out).toContain("publish web: 0 written, 0 removed, 8 unchanged");
    expect(second.out).toContain("publish admin: 0 written, 0 removed, 8 unchanged");
  });

  it("Review Focus 5: leftovers of an earlier run are removed, and the scan is clean afterwards", () => {
    const root = miniRepo();
    const fonts = fakeFonts();
    run(["--stage", "publish"], root, fonts);
    write(root, {
      "apps/web/public/theme/assets/js/old.js": "x",
      "apps/web/public/theme/assets/css/old.css": "b{}",
    });
    const result = run(["--stage", "publish", "--app", "web"], root, fonts);
    expect(result.code).toBe(0);
    expect(result.out).toContain("publish web: 0 written, 2 removed, 8 unchanged");
    expect(existsSync(join(root, "apps/web/public/theme/assets/js"))).toBe(false);
  });

  it("--app limits the stage to one app", () => {
    const root = miniRepo();
    expect(run(["--stage", "publish", "--app", "admin"], root).code).toBe(0);
    expect(existsSync(join(root, "apps/admin/public/theme/tc.css"))).toBe(true);
    expect(existsSync(join(root, "apps/web"))).toBe(false);
  });

  it("--check says what is missing, then what is right", () => {
    const root = miniRepo();
    const fonts = fakeFonts();
    const before = run(["--stage", "publish", "--check"], root, fonts);
    expect(before.code).toBe(1);
    expect(before.err).toContain(
      `publish web: ${join(root, "apps/web/public/theme")} differs from what the stage writes`,
    );
    expect(before.err).toContain("  missing: tc.css");
    expect(before.out.some((line) => line.includes("scanned"))).toBe(false);
    expect(existsSync(join(root, "apps"))).toBe(false);
    run(["--stage", "publish"], root, fonts);
    expect(run(["--stage", "publish", "--check"], root, fonts)).toMatchObject({ code: 0 });
  });

  it("fails when the scan finds a script that the file names do not show", () => {
    const root = miniRepo({ [`${VENDORED_ASSETS}/img/copy.svg`]: SCRIPT });
    const result = run(["--stage", "publish", "--app", "web"], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "FOUND theme-script-bytes assets/img/copy.svg: same bytes as a script of the theme",
    );
  });

  it("without --stage runs the import stage and then the publish stage", () => {
    const root = temp("publish-");
    write(root, {
      "design/mockup/template/assets/js/lib.js": SCRIPT,
      "design/mockup/template/assets/css/a.css": "a{background:url(../img/x.svg)}",
      "design/mockup/template/assets/img/x.svg": SVG,
      "design/mockup/template/assets/fonts/svg/inline.svg": SVG,
      [TC_CSS]: TC,
    });
    const result = run([], root);
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out.filter((l) => /^(import|publish)(?: \w+)?: \d+ files/.test(l))).toHaveLength(
      2,
    );
    expect(existsSync(join(root, VENDORED_ASSETS, "fonts/svg/inline.svg"))).toBe(true);
    expect(existsSync(join(root, "apps/web/public/theme/assets/fonts/svg/inline.svg"))).toBe(false);
    expect(existsSync(join(root, "apps/admin/public/theme/tc.css"))).toBe(true);
  });

  it("refuses an unknown app, and a list of the theme's scripts that is gone (the scan needs it, R16)", () => {
    expect(run(["--stage", "publish", "--app", "nope"], miniRepo()).code).toBe(1);
    const noList = temp("publish-");
    write(noList, { [`${VENDORED_ASSETS}/css/a.css`]: "a{}", [TC_CSS]: TC });
    const result = run(["--stage", "publish"], noList);
    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/\(missing_input\)$/);
  });
});

describe("the real repository", { timeout: 30000 }, () => {
  const real = {
    vendoredRoot: join(repoRoot, VENDORED_ASSETS),
    tcCssFile: join(repoRoot, TC_CSS),
    fontPackageDir,
    manifest: THEME_MANIFEST,
  };
  const { tree, refs } = buildPublishTree(real);

  it("publishes 61 files: the 55 of the theme, tc.css, three fonts and two licences", () => {
    expect(tree.files).toHaveLength(61);
    const paths = tree.files.map((f) => f.path);
    expect(paths.filter((p) => p.startsWith("assets/"))).toHaveLength(55);
    expect(paths.filter((p) => p.startsWith("fonts/"))).toHaveLength(5);
    expect(paths).toContain("tc.css");
    expect(refs).toMatchObject({ shipped: 24 });
    expect(refs.unshippedFallbacks).toHaveLength(4);
    expect(refs.knownMissing).toHaveLength(4);
    expect(buildPublishTree(real).tree.digest).toBe(tree.digest);
  });

  it("holds every file that the root layout will ask for", () => {
    const paths = new Set(tree.files.map((f) => `/theme/${f.path}`));
    for (const href of THEME_STYLESHEETS) expect(paths.has(href), href).toBe(true);
    for (const preload of fontPreloads("bn"))
      expect(paths.has(preload.href), preload.href).toBe(true);
  });

  it("Review Focus 4: the real output has no file from the theme's assets/js, no jQuery, no other origin (checked against the committed list, not design/)", () => {
    const dest = temp("real-");
    writeTree(tree, dest);
    const { files, findings } = scanOutput(
      dest,
      scriptHashSet(readScriptList(join(repoRoot, SCRIPT_HASH_FILE))),
    );
    expect([files, findings]).toEqual([61, []]);
    for (const path of listFiles(dest))
      expect(path, path).not.toMatch(/\.(js|mjs|cjs|map|php|tpl)$/);
    expect(readFileSync(join(dest, "tc.css"), "utf8")).toBe(readFileSync(real.tcCssFile, "utf8"));
  });
});
