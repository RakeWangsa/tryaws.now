import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refKind, resolveRef, scanCssRefs } from "./css-refs.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("scanCssRefs", () => {
  it("finds url() in every quoting form, in document order", () => {
    const css = `a{background:url(a.png)} b{background:url("b c.png")} c{background:url( 'c.png' )}
      @font-face{src:url(d.woff2) format("woff2"),url(d.ttf) format("truetype")}`;
    expect(scanCssRefs(css).map((r) => r.raw)).toEqual([
      "a.png",
      "b c.png",
      "c.png",
      "d.woff2",
      "d.ttf",
    ]);
  });

  it("keeps @import and url() in one document order", () => {
    expect(scanCssRefs(`@import "a.css"; b{background:url(c.png)} @import url(d.css);`)).toEqual([
      { raw: "a.css", kind: "import" },
      { raw: "c.png", kind: "url" },
      { raw: "d.css", kind: "import" },
    ]);
  });

  it("finds @import with a string and with url()", () => {
    expect(
      scanCssRefs(`@import "x.css"; @import url(y.css) screen; @import url('z.css');`),
    ).toEqual([
      { raw: "x.css", kind: "import" },
      { raw: "y.css", kind: "import" },
      { raw: "z.css", kind: "import" },
    ]);
  });

  it("does not read comments, and returns a data: URI as written", () => {
    expect(scanCssRefs(`/* url(no.png) */ a{color:red} /* @import "no.css"; */`)).toEqual([]);
    expect(scanCssRefs(`a{background:url(data:image/png;base64,AAAA)}`)).toEqual([
      { raw: "data:image/png;base64,AAAA", kind: "url" },
    ]);
  });

  it("reads the real theme.min.css: many references, all relative files", () => {
    const css = readFileSync(`${repoRoot}design/mockup/template/assets/css/theme.min.css`, "utf8");
    const refs = scanCssRefs(css);
    expect(refs.length).toBeGreaterThan(30);
    expect(refs.every((r) => r.kind === "url" && refKind(r.raw) === "relative")).toBe(true);
    expect(refs.map((r) => r.raw)).toContain("../patterns/exapath.svg");
    expect(refs.map((r) => r.raw)).toContain("../../assets/img/topbanner01.jpg");
  });
});

it.each([
  ["data:image/svg+xml;base64,AAAA", "data"],
  ["DATA:text/plain,x", "data"],
  ["https://fonts.googleapis.com/css2", "external"],
  ["http://x.test/a.png", "external"],
  ["//cdn.example.com/a.css", "external"],
  ["/theme/tc.css", "root-relative"],
  ["../img/a.svg", "relative"],
  ["a.svg", "relative"],
  ["./fonts/a.woff2?x#y", "relative"],
])("refKind(%s) is %s", (raw, kind) => {
  expect(refKind(raw)).toBe(kind);
});

it.each([
  [
    "assets/css/vendors.min.css",
    "../img/filter/cd-icon-arrow.svg",
    "assets/img/filter/cd-icon-arrow.svg",
  ],
  ["assets/css/theme.min.css", "../../assets/img/topbanner01.jpg", "assets/img/topbanner01.jpg"],
  [
    "assets/fonts/fonts.min.css",
    "./../fonts/cloudicon/Cloudicon.eot?h7rmut#iefix",
    "assets/fonts/cloudicon/Cloudicon.eot",
  ],
  [
    "assets/fonts/fontawesome/css/all.min.css",
    "../webfonts/fa-solid-900.woff2",
    "assets/fonts/fontawesome/webfonts/fa-solid-900.woff2",
  ],
  [
    "tc.css",
    "./fonts/open-sans-latin-wght-normal.woff2",
    "fonts/open-sans-latin-wght-normal.woff2",
  ],
  ["assets/css/theme.min.css", "../../../x.png", null],
  ["assets/css/a.css", "https://x.test/a.png", null],
  ["assets/css/a.css", "//x.test/a.png", null],
  ["assets/css/a.css", "data:image/png;base64,AA==", null],
  ["assets/css/a.css", "/abs/a.png", null],
  ["assets/css/a.css", "#fragment-only", null],
])("resolveRef(%s, %s) is %s", (from, raw, expected) => {
  expect(resolveRef(from, raw)).toBe(expected);
});
