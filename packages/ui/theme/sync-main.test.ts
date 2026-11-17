import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { listFiles } from "./glob.ts";
import { MOCKUP_ASSETS, VENDORED_ASSETS, type ThemeManifest } from "./manifest.ts";
import { antlerThemePresent } from "./present.ts";
import { SCRIPT_HASH_FILE } from "./script-hashes.ts";
import { syncThemeMain } from "./sync-main.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"/>`;
const SCRIPT = `/* a theme script */ ${"x".repeat(150)}`;
const manifest: ThemeManifest = {
  shipped: [
    { cell: 0, pattern: "css/*.css" },
    { cell: 1, pattern: "img/*.svg" },
  ],
  neverShipped: [{ cell: 0, token: "js/*" }],
  knownMissing: [],
  unshippedFallbacks: [],
};
const FILES = {
  "css/a.css": "a{color:red}",
  "css/b.css": "b{color:blue}",
  "img/x.svg": SVG,
  "js/lib.js": SCRIPT,
};
const IMPORT = ["--stage", "import"];

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sync-"));
  made.push(root);
  return root;
}
function miniRepo(files: Record<string, string>): string {
  const root = emptyRoot();
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, MOCKUP_ASSETS, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}
/** `use` is the manifest of the run; null means the real THEME_MANIFEST. */
function run(argv: string[], root: string, use: ThemeManifest | null = manifest) {
  const out: string[] = [];
  const err: string[] = [];
  const code = syncThemeMain(argv, {
    repoRoot: root,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(use === null ? {} : { manifest: use }),
  });
  return { code, out, err };
}

describe("--stage import on a small repository", () => {
  it("writes the vendored copy, and a second run writes nothing (Review Focus 5)", () => {
    const root = miniRepo(FILES);
    const first = run(IMPORT, root);
    expect(first.code).toBe(0);
    expect(first.out[0]).toMatch(/^import: 3 files, 66 bytes, digest [0-9a-f]{64}$/);
    expect(first.out).toContain("import: 3 written, 0 removed, 0 unchanged");
    expect(first.out).toContain("import: scripts: 1 listed, 1 hashed, written");
    expect(readFileSync(join(root, SCRIPT_HASH_FILE), "utf8")).toMatch(
      /^[0-9a-f]{64} {2}\d+ {2}template\/assets\/js\/lib\.js\n$/,
    );
    expect(listFiles(join(root, VENDORED_ASSETS))).toEqual(["css/a.css", "css/b.css", "img/x.svg"]);
    const second = run(IMPORT, root);
    expect(second.code).toBe(0);
    expect(second.out).toContain("import: 0 written, 0 removed, 3 unchanged");
    expect(second.out).toContain("import: scripts: 1 listed, 1 hashed, unchanged");
    expect(second.out[0]).toBe(first.out[0]);
  });

  it("--check writes nothing and says what differs", () => {
    const root = miniRepo(FILES);
    const dest = join(root, VENDORED_ASSETS);
    const list = join(root, SCRIPT_HASH_FILE);
    const before = run([...IMPORT, "--check"], root);
    expect(before.code).toBe(1);
    expect(before.err).toEqual([
      `import: ${dest} differs from what the stage writes`,
      "  missing: css/a.css",
      "  missing: css/b.css",
      "  missing: img/x.svg",
      `import: ${list} differs from what the stage writes`,
    ]);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(list)).toBe(false);

    run(IMPORT, root);
    expect(run([...IMPORT, "--check"], root)).toMatchObject({ code: 0 });
    expect(run([...IMPORT, "--check"], root).out).toContain("import: in sync");
    expect(run([...IMPORT, "--check"], root).out).toContain(
      "import: scripts: 1 listed, 1 hashed, in sync",
    );

    writeFileSync(list, "tampered");
    const listOnly = run([...IMPORT, "--check"], root);
    expect([listOnly.code, listOnly.err]).toEqual([
      1,
      [`import: ${list} differs from what the stage writes`],
    ]);
    expect(readFileSync(list, "utf8")).toBe("tampered");
    run(IMPORT, root);

    writeFileSync(join(dest, "css/a.css"), "tampered");
    writeFileSync(join(dest, "css/extra.css"), "x");
    const after = run([...IMPORT, "--check"], root);
    expect(after.code).toBe(1);
    expect(after.err.slice(1)).toEqual(["  changed: css/a.css", "  stray: css/extra.css"]);
    expect(readFileSync(join(dest, "css/a.css"), "utf8")).toBe("tampered");

    expect(run(IMPORT, root).out).toContain("import: 1 written, 1 removed, 2 unchanged");
    expect(run([...IMPORT, "--check"], root).code).toBe(0);
  });

  it("refuses a forbidden file and writes nothing", () => {
    const root = miniRepo({ ...FILES, "js/evil.js": "alert(1)" });
    const bad = { ...manifest, shipped: [...manifest.shipped, { cell: 2, pattern: "js/*.js" }] };
    const result = run(IMPORT, root, bad);
    expect(result.code).toBe(1);
    expect(result.err[0]).toBe(
      "theme-sync: the allow-list gives a file that must never be shipped (forbidden_file)",
    );
    expect(result.err[1]).toBe("  js/evil.js: a .js file (U2)");
    expect(existsSync(join(root, VENDORED_ASSETS))).toBe(false);
  });

  it("refuses a mockup without scripts, and writes nothing (R16)", () => {
    const root = miniRepo({ "css/a.css": "a{color:red}", "img/x.svg": SVG });
    const result = run(IMPORT, root);
    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/\(missing_input\)$/);
    expect(existsSync(join(root, VENDORED_ASSETS))).toBe(false);
  });

  // WPU-X30a (docs/theme.md): a public checkout has no mockup. That is the theme-less mode: say so,
  // write nothing, exit 0. A mockup that is there but wrong is still refused (the two tests above).
  it("a mockup that is not there is the theme-less mode: one notice, nothing written, exit 0", () => {
    const root = emptyRoot();
    for (const argv of [IMPORT, [...IMPORT, "--check"]]) {
      const result = run(argv, root);
      expect([result.code, result.err]).toEqual([0, []]);
      expect(result.out).toEqual([
        "theme-sync: the Antler theme is not in this checkout (theme-less mode).",
        "  Antler is a paid third-party theme (Envato). It is not part of the public repository.",
        `  missing: ${MOCKUP_ASSETS}`,
        `  missing: ${VENDORED_ASSETS}`,
        "  Without it the apps build, with tc.css and the self-hosted fonts and no theme styling.",
        "  To use your own licensed copy, follow docs/theme.md",
        `import: skipped, ${MOCKUP_ASSETS} is absent`,
      ]);
    }
    expect(existsSync(join(root, VENDORED_ASSETS))).toBe(false);
    expect(existsSync(join(root, SCRIPT_HASH_FILE))).toBe(false);
  });

  it("names only the folder that is missing: a vendored copy without its mockup", () => {
    const root = emptyRoot();
    mkdirSync(join(root, VENDORED_ASSETS), { recursive: true });
    const result = run(IMPORT, root);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`  missing: ${MOCKUP_ASSETS}`);
    expect(result.out).not.toContain(`  missing: ${VENDORED_ASSETS}`);
  });

  it("prints the usage for --help (exit 0) and for a wrong request (exit 1)", () => {
    const root = miniRepo(FILES);
    expect(run(["--help"], root)).toMatchObject({ code: 0 });
    expect(run(["--help"], root).out[0]).toMatch(/^usage: node scripts\/sync-theme\.ts/);
    for (const argv of [["--bogus"], ["--stage"], ["--stage", "nope"], ["import"]]) {
      const result = run(argv, root);
      expect([argv, result.code]).toEqual([argv, 1]);
      expect(result.err[0]).toMatch(/^usage: /);
    }
  });
});

describe("the real repository", () => {
  it.skipIf(!antlerThemePresent())(
    "the committed copy in packages/ui/theme/assets is the 16.3 allow-list of the mockup, byte for byte",
    () => {
      const result = run(["--stage", "import", "--check"], repoRoot, null);
      expect(result.err).toEqual([]);
      expect(result.out[0]).toMatch(/^import: 55 files, 2416190 bytes, digest [0-9a-f]{64}$/);
      expect(result.out).toContain("import: in sync");
      expect(
        result.out.some((line) => /^import: scripts: \d+ listed, \d+ hashed, in sync$/.test(line)),
      ).toBe(true);
      expect(result.code).toBe(0);
    },
    30000,
  );

  it("scripts/sync-theme.ts runs under the pinned Node without a build step", () => {
    const script = `${repoRoot}scripts/sync-theme.ts`;
    const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
    expect([help.status, help.stderr]).toEqual([0, ""]);
    expect(help.stdout).toMatch(/^usage: node scripts\/sync-theme\.ts/);
    expect(spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8" }).status).toBe(1);
    const check = spawnSync(process.execPath, [script, "--stage", "import", "--check"], {
      encoding: "utf8",
    });
    expect([check.status, check.stderr]).toEqual([0, ""]);
  }, 30000);
});
