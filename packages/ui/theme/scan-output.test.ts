import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mockupPresent } from "./present.ts";
import { scanOutput, scanThemeOutputMain, type Finding } from "./scan-output.ts";
import {
  SCRIPT_HASH_FILE,
  buildScriptList,
  formatScriptList,
  readScriptList,
  scriptHashSet,
  type ScriptEntry,
} from "./script-hashes.ts";
import { ThemeError, sha256Of } from "./tree.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const mockup = `${repoRoot}design/mockup`;
const haveMockup = mockupPresent();
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
// With the mockup, the real jQuery of the theme is the sample and the real list is the list. Without
// it (a public checkout, docs/theme.md) a stand-in that carries the same signature and is on the
// list takes its place, so the scanner itself is tested in both situations. Only the two tests that
// compare with the real files skip.
const STAND_IN = `/*! jQuery requires a window with a document */ ${"x".repeat(200)}`;
const standInDir = mkdtempSync(join(tmpdir(), "stand-in-"));
made.push(standInDir);
writeFileSync(join(standInDir, "jquery.min.js"), STAND_IN);
const jquery = haveMockup
  ? `${mockup}/template/assets/js/jquery.min.js`
  : join(standInDir, "jquery.min.js");
const standInList: ScriptEntry[] = [
  {
    path: "template/assets/js/jquery.min.js",
    bytes: STAND_IN.length,
    sha256: sha256Of(Buffer.from(STAND_IN)),
  },
];
const list = haveMockup ? buildScriptList(mockup) : standInList;
const hashes = scriptHashSet(list);
/** The list of the mockup as a file, for the command-line tests. */
const hashDir = mkdtempSync(join(tmpdir(), "hashes-"));
made.push(hashDir);
const hashFile = join(hashDir, "script-hashes.txt");
writeFileSync(hashFile, formatScriptList(list));

function output(files: Record<string, string | { copyOf: string; append?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "scan-"));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if (typeof content === "string") writeFileSync(join(root, path), content);
    else {
      copyFileSync(content.copyOf, join(root, path));
      if (content.append !== undefined)
        writeFileSync(join(root, path), readFileSync(join(root, path), "utf8") + content.append);
    }
  }
  return root;
}
const rules = (findings: Finding[]): string[] => findings.map((f) => `${f.rule} ${f.file}`).sort();
const CHUNK =
  "(self.webpackChunk=self.webpackChunk||[]).push([[1],{1:function(e){e.exports=function(){return 42}}}]);".repeat(
    3,
  );

describe("the hashes of the theme's scripts", () => {
  it.skipIf(!haveMockup)(
    "hold the sha256 of every script of the zip that is at least 100 bytes",
    () => {
      expect(hashes.size).toBeGreaterThan(40);
      expect(hashes.has(sha256Of(readFileSync(jquery)))).toBe(true);
      expect(hashes.has(sha256Of(readFileSync(`${mockup}/template/assets/js/custom.js`)))).toBe(
        false,
      );
    },
  );

  it.skipIf(!haveMockup)(
    "the committed list packages/ui/theme/script-hashes.txt equals the list of design/mockup (so the scan needs no design/)",
    () => {
      expect(readScriptList(join(repoRoot, SCRIPT_HASH_FILE))).toEqual(list);
    },
  );
});

describe("scanOutput", () => {
  it("finds nothing in a clean output, and counts the files", () => {
    const dir = output({
      "theme/tc.css": "a{color:red}",
      "theme/assets/css/theme.min.css": "a{background:url(../patterns/exapath.svg)}",
      "theme/fonts/open-sans-latin-wght-normal.woff2": "font",
      "_next/static/chunks/main-abc123.js": CHUNK,
    });
    expect(scanOutput(dir, hashes)).toEqual({ files: 4, findings: [] });
  });

  it("finds the jQuery of the theme where the theme put it (path, bytes and signature)", () => {
    const dir = output({ "public/theme/assets/js/jquery.min.js": { copyOf: jquery } });
    const { findings } = scanOutput(dir, hashes);
    expect(rules(findings)).toEqual([
      "forbidden-path public/theme/assets/js/jquery.min.js",
      "jquery-signature public/theme/assets/js/jquery.min.js",
      "theme-script-bytes public/theme/assets/js/jquery.min.js",
    ]);
    const detail = (rule: string): string | undefined =>
      findings.find((f) => f.rule === rule)?.detail;
    expect(detail("forbidden-path")).toBe("a .js file (U2)");
    expect(detail("theme-script-bytes")).toBe("same bytes as a script of the theme");
    expect(detail("jquery-signature")).toMatch(
      /^contains the jQuery signature "(jQuery requires a window with a document|jquery\.org\/license)"$/,
    );
  });

  it("finds a renamed copy by its bytes and a changed copy by its signature", () => {
    const dir = output({
      "_next/static/chunks/abc123.js": { copyOf: jquery },
      "_next/static/chunks/def456.js": { copyOf: jquery, append: "\n/* changed */" },
    });
    expect(rules(scanOutput(dir, hashes).findings)).toEqual([
      "jquery-signature _next/static/chunks/abc123.js",
      "jquery-signature _next/static/chunks/def456.js",
      "theme-script-bytes _next/static/chunks/abc123.js",
    ]);
  });

  it.each([
    ["theme/assets/fonts/fontawesome/js/all.min.js", "a .js file (U2)"],
    ["public/theme/assets/img/topbanner01.jpg", "on the never-shipped list: img/topbanner*.jpg"],
    ["theme/assets/img/logo.svg", "on the never-shipped list: img/logo.svg"],
    ["theme/assets/locales/en/translations.json", "on the never-shipped list: locales/*"],
    ["theme/extra/app.js", "a .js file in the theme folder (U2)"],
    ["theme/assets/css/aos.min.css", "on the never-shipped list: css/aos.min.css"],
    ["static/form-process.php", "a .php file (U2)"],
    ["static/cart.tpl", "a .tpl file (U2)"],
    ["static/order-form/antler/style.css", "a file under order-form/ (U2)"],
  ])("refuses %s", (path, detail) => {
    const { findings } = scanOutput(
      output({ [path]: path.endsWith(".css") ? "a{}" : "x" }),
      hashes,
    );
    expect(findings.map((f) => [f.rule, f.file, f.detail])).toEqual([
      ["forbidden-path", path, detail],
    ]);
  });

  it("lets the JavaScript of a build stand (only the theme folder is checked by name)", () => {
    const dir = output({
      ".next/static/chunks/app/page-1a2b3c.js": CHUNK,
      ".next/server/app/page.js": CHUNK,
    });
    expect(scanOutput(dir, hashes).findings).toEqual([]);
  });

  it("finds a stylesheet that names another origin, and lets a path from the root stand", () => {
    const dir = output({
      "static/css/a.css": "a{background:url(https://cdn.example.com/x.png)}",
      "static/css/b.css": "a{background:url(/_next/static/media/x.woff2)}",
    });
    const { findings } = scanOutput(dir, hashes);
    expect(rules(findings)).toEqual(["external-reference static/css/a.css"]);
    expect(findings[0]?.detail).toBe("refers to another origin: https://cdn.example.com/x.png");
  });

  it("does not vouch for a stylesheet it cannot parse (R16)", () => {
    const dir = output({ "static/css/broken.css": "x" });
    const { findings } = scanOutput(dir, hashes);
    expect(rules(findings)).toEqual(["unparsable-css static/css/broken.css"]);
    expect(findings[0]?.detail).toBe("cannot be parsed");
  });

  it("refuses a folder that does not exist, and an empty set of hashes still finds paths and signatures", () => {
    expect(() => scanOutput(join(tmpdir(), "no-such-output"), hashes)).toThrow(ThemeError);
    const dir = output({ "theme/assets/js/x.js": { copyOf: jquery } });
    expect(rules(scanOutput(dir, new Set()).findings)).toEqual([
      "forbidden-path theme/assets/js/x.js",
      "jquery-signature theme/assets/js/x.js",
    ]);
  });
});

describe("scanThemeOutputMain and scripts/scan-theme-output.ts", () => {
  const run = (argv: string[], cwd: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = scanThemeOutputMain(argv, {
      cwd,
      hashFile,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err };
  };

  it("exits 0 for clean folders and 1 for a finding, a missing folder or no folder", () => {
    const clean = output({ "theme/tc.css": "a{color:red}" });
    const dirty = output({ "theme/assets/js/jquery.min.js": { copyOf: jquery } });
    expect(run([clean], "/")).toEqual({
      code: 0,
      out: [`scanned 1 files in ${clean}: 0 findings`],
      err: [],
    });
    const bad = run([clean, dirty], "/");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(
      "FOUND forbidden-path theme/assets/js/jquery.min.js: a .js file (U2)",
    );
    expect(run(["nope"], tmpdir()).code).toBe(1);
    expect(run([], "/").code).toBe(1);
    expect(run(["--flag"], "/").code).toBe(1);
  }, 30000);

  it("exits 1 when the list of the theme's scripts is missing (R16), and does not need design/", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = scanThemeOutputMain([output({ "a.txt": "hello" })], {
      cwd: "/",
      hashFile: join(tmpdir(), "no-such-hashes.txt"),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect([code, out, err[0]]).toEqual([
      1,
      [],
      expect.stringMatching(/^theme-scan: .*\(missing_input\)$/),
    ]);
  });

  it("runs under the pinned Node without a build step", () => {
    const dirty = output({ "theme/assets/js/jquery.min.js": { copyOf: jquery } });
    const script = `${repoRoot}scripts/scan-theme-output.ts`;
    const result = spawnSync(process.execPath, [script, dirty], { encoding: "utf8" });
    expect(result.status).toBe(1);
    // The command reads the committed list of the real theme's scripts, which the stand-in is not on:
    // without the mockup the path and the signature are what it finds.
    expect(result.stderr).toContain(
      haveMockup
        ? "FOUND theme-script-bytes theme/assets/js/jquery.min.js"
        : "FOUND jquery-signature theme/assets/js/jquery.min.js",
    );
    const clean = spawnSync(process.execPath, [script, output({ "a.txt": "hello" })], {
      encoding: "utf8",
    });
    expect([clean.status, clean.stderr]).toEqual([0, ""]);
  }, 30000);
});
