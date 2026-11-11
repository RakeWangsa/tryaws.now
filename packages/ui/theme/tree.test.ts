import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ThemeManifest } from "./manifest.ts";
import { ThemeError, classifyRefs, listTree, svgProblems, treeDigest } from "./tree.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const failure = (action: () => unknown): ThemeError => {
  try {
    action();
  } catch (error) {
    if (error instanceof ThemeError) return error;
    throw error;
  }
  throw new Error("expected a ThemeError");
};

describe("treeDigest", () => {
  it("is the sha256 of one line per file, '<path>\\t<sha256>\\n', in the order of the paths", () => {
    const a = { path: "a", sha256: "11" };
    const b = { path: "b", sha256: "22" };
    expect(treeDigest([b, a])).toBe(
      "de2307a877c94fe702cf64d2ceb00def323dea6c8dcca6b071b7b449ea6e26d0",
    );
    expect(treeDigest([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("svgProblems", () => {
  it.each([
    [`<svg><script>alert(1)</script></svg>`, "contains a script element"],
    [`<svg><foreignObject/></svg>`, "contains a foreignObject element"],
    [`<svg onload="x()"/>`, "contains an event handler attribute"],
    [`<svg><a href="javascript:x()"/></svg>`, "contains a javascript: URL"],
    [`<svg><image href="https://evil.test/x.png"/></svg>`, "refers to another origin"],
    [`<svg><image xlink:href='//evil.test/x.png'/></svg>`, "refers to another origin"],
    [`<svg><style>@import url(https://evil.test/a.css);</style></svg>`, "refers to another origin"],
    [`<svg><rect style="fill:url(//evil.test/p)"/></svg>`, "refers to another origin"],
  ])("%s: %s", (svg, problem) => {
    expect(svgProblems(svg)).toContain(problem);
  });

  it("accepts a namespace, a DOCTYPE and a comment that holds a web address (Cloudicon.svg names its maker)", () => {
    const svg =
      `<?xml version="1.0"?><!-- made by http://inebur.com/ -->` +
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">` +
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>`;
    expect(svgProblems(svg)).toEqual([]);
  });
});

describe("classifyRefs", () => {
  const manifest: ThemeManifest = {
    shipped: [],
    neverShipped: [{ cell: 0, token: "img/topbanner*.jpg" }],
    knownMissing: ["img/gone.png"],
    unshippedFallbacks: ["img/fallback.ttf"],
  };
  const inTree = new Set(["assets/css/a.css", "assets/img/ok.svg"]);
  const sheet = (text: string) => [{ path: "assets/css/a.css", text }];

  it("sorts references into the classes of 16.3 and skips data: URIs", () => {
    const css =
      "a{background:url(../img/ok.svg)} b{background:url(../img/gone.png)} " +
      "c{background:url(../../assets/img/topbanner01.jpg)} d{src:url(../img/fallback.ttf)} " +
      "e{background:url(data:image/png;base64,AA==)} f{background:url(../img/ok.svg?v=1#x)}";
    expect(classifyRefs(sheet(css), inTree, manifest)).toEqual({
      shipped: 1,
      neverShipped: ["img/topbanner01.jpg"],
      knownMissing: ["img/gone.png"],
      unshippedFallbacks: ["img/fallback.ttf"],
    });
  });

  it("Review Focus 4: a theme update cannot add another origin, with url() or @import, or a path from the root of the site", () => {
    for (const css of [
      "a{background:url(https://cdn.example.com/x.png)}",
      '@import "https://fonts.example.com/f.css"; a{color:red}',
      "a{background:url(//cdn.example.com/x.png)}",
      "a{background:url(/theme/x.png)}",
    ]) {
      expect(failure(() => classifyRefs(sheet(css), inTree, manifest)).code, css).toBe(
        "external_reference",
      );
    }
  });

  it("Review Focus 4: a theme update cannot add a silent dependency: a file in none of the classes, or a path that leaves the tree", () => {
    const css = "a{background:url(../img/unknown.png)} b{background:url(../../../etc/x.png)}";
    const error = failure(() => classifyRefs(sheet(css), inTree, manifest));
    expect([error.code, error.details]).toEqual([
      "unclassified_reference",
      ["assets/css/a.css: ../../../etc/x.png", "img/unknown.png"],
    ]);
    expect(error.message).toBe("a shipped stylesheet refers to a file in no class of 16.3");
  });

  it("16.1: a shipped stylesheet has no @import, not even of a shipped file", () => {
    const error = failure(() =>
      classifyRefs(sheet('@import "../img/ok.svg"; a{color:red}'), inTree, manifest),
    );
    expect([error.code, error.details]).toEqual([
      "unclassified_reference",
      ["assets/css/a.css: @import ../img/ok.svg"],
    ]);
  });
});

describe("listTree", () => {
  it("reports a symbolic link and a missing folder as a ThemeError", () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-"));
    made.push(dir);
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a/real.txt"), "x");
    expect(listTree(dir)).toEqual(["a/real.txt"]);
    symlinkSync(join(dir, "a/real.txt"), join(dir, "a/link.txt"));
    expect(failure(() => listTree(dir)).code).toBe("symlink");
    expect(failure(() => listTree(join(dir, "nope"))).code).toBe("missing_input");
  });
});
