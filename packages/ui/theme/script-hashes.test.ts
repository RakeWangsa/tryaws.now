import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildScriptList,
  formatScriptList,
  parseScriptList,
  readScriptList,
  scriptHashSet,
} from "./script-hashes.ts";
import { ThemeError, sha256Of } from "./tree.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const BIG = `/* a theme script */ ${"x".repeat(150)}`;
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function mockup(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "scripts-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const code = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return error instanceof ThemeError ? error.code : "other error";
  }
  return "no error";
};

describe("buildScriptList", () => {
  it("lists the files of the five script sources, sorted, with size and hash, and nothing else", () => {
    const root = mockup({
      "template/assets/js/b.js": BIG,
      "template/assets/js/lib/a.js": "tiny",
      "template/assets/fonts/fontawesome/js/all.min.js": BIG + "2",
      "template/assets/php/form.php": BIG + "3",
      "order-form/antler/x.js": BIG + "4",
      "whmcs-template/antler/js/y.js": BIG + "5",
      "template/assets/css/theme.min.css": "a{}",
      "order-form/antler/style.css": "a{}",
    });
    const list = buildScriptList(root);
    expect(list.map((e) => e.path)).toEqual([
      "order-form/antler/x.js",
      "template/assets/fonts/fontawesome/js/all.min.js",
      "template/assets/js/b.js",
      "template/assets/js/lib/a.js",
      "template/assets/php/form.php",
      "whmcs-template/antler/js/y.js",
    ]);
    const b = list.find((e) => e.path === "template/assets/js/b.js");
    expect(b).toEqual({
      path: "template/assets/js/b.js",
      bytes: BIG.length,
      sha256: sha256Of(Buffer.from(BIG)),
    });
  });

  it("refuses a mockup that is not there, and one without scripts (R16)", () => {
    expect(code(() => buildScriptList(join(tmpdir(), "no-such-mockup")))).toBe("missing_input");
    expect(code(() => buildScriptList(mockup({ "template/assets/css/a.css": "a{}" })))).toBe(
      "missing_input",
    );
  });
});

describe("the text form", () => {
  const entries = [
    { path: "a/x.js", bytes: 150, sha256: "a".repeat(64) },
    { path: "b/y.js", bytes: 12, sha256: "b".repeat(64) },
  ];

  it("round-trips, one line per file, in the form of sha256sum with the size", () => {
    const text = formatScriptList(entries);
    expect(text).toBe(`${"a".repeat(64)}  150  a/x.js\n${"b".repeat(64)}  12  b/y.js\n`);
    expect(parseScriptList(text)).toEqual(entries);
  });

  it.each([
    "",
    "not a line\n",
    `${"a".repeat(63)}  1  a.js\n`,
    `${"b".repeat(64)}  1  b.js\n${"a".repeat(64)}  1  a.js\n`,
  ])("refuses %j", (text) => {
    expect(code(() => parseScriptList(text))).toBe("missing_input");
  });

  it("readScriptList refuses a file that does not exist", () => {
    expect(code(() => readScriptList(join(tmpdir(), "no-such-list.txt")))).toBe("missing_input");
  });

  it("scriptHashSet leaves out the files below 100 bytes", () => {
    expect(scriptHashSet(entries)).toEqual(new Set(["a".repeat(64)]));
  });
});

describe("the real mockup (Antler 4.5.0)", () => {
  it("lists more than 40 hashed scripts, jquery.min.js among them, and no stylesheet", () => {
    const list = buildScriptList(`${repoRoot}design/mockup`);
    expect(scriptHashSet(list).size).toBeGreaterThan(40);
    expect(list.map((e) => e.path)).toContain("template/assets/js/jquery.min.js");
    expect(list.every((e) => !e.path.endsWith(".css"))).toBe(true);
  });
});
