import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  faceFor,
  fontPackageDir,
  inRanges,
  parseUnicodeRange,
  readFontFaces,
  type FontFace,
} from "./font-faces.ts";

describe("parseUnicodeRange", () => {
  it("reads single code points, ranges and wildcards, with spaces and in any case", () => {
    expect(parseUnicodeRange("U+0980-09FE,U+200C")).toEqual([
      [0x980, 0x9fe],
      [0x200c, 0x200c],
    ]);
    expect(parseUnicodeRange("u+4??, U+0000-00FF")).toEqual([
      [0x400, 0x4ff],
      [0, 0xff],
    ]);
    expect(parseUnicodeRange("U+10FFFF")).toEqual([[0x10ffff, 0x10ffff]]);
  });

  it.each(["", "0980", "U+", "U+110000", "U+09FE-0980", "U+4??-4FF", "U+12G", "U+0980,,U+0990"])(
    "refuses %j",
    (text) => {
      expect(() => parseUnicodeRange(text)).toThrow(RangeError);
    },
  );

  it("inRanges tests the edges", () => {
    const ranges = parseUnicodeRange("U+0980-09FE,U+200C");
    expect([0x97f, 0x980, 0x9fe, 0x9ff, 0x200c, 0x200d].map((c) => inRanges(ranges, c))).toEqual([
      false,
      true,
      true,
      false,
      true,
      false,
    ]);
  });
});

const CSS = `
@font-face { font-family: "Open Sans"; src: url(./fonts/a.woff2) format("woff2"); unicode-range: U+0000-00FF; }
@font-face { font-family: 'Open Sans'; font-style: normal; font-weight: 300 800; font-stretch: 100%; font-display: swap;
  src: url("./fonts/b.woff2") format("woff2"); unicode-range: U+0041-005A, U+0980-09FE; }
body { color: red }`;

describe("readFontFaces", () => {
  it("reads the blocks in source order, with defaults for what is missing", () => {
    expect(readFontFaces(CSS).map((f) => ({ ...f, ranges: f.ranges.length }))).toEqual([
      {
        family: "Open Sans",
        style: "normal",
        weight: "normal",
        stretch: "normal",
        display: "auto",
        url: "./fonts/a.woff2",
        ranges: 1,
      },
      {
        family: "Open Sans",
        style: "normal",
        weight: "300 800",
        stretch: "100%",
        display: "swap",
        url: "./fonts/b.woff2",
        ranges: 2,
      },
    ]);
  });

  it.each([
    "@font-face { font-family: X; src: url(a.woff2), url(b.woff2); unicode-range: U+0-7F; }",
    "@font-face { font-family: X; src: local(Arial); unicode-range: U+0-7F; }",
    "@font-face { font-family: X; src: url(a.woff2); }",
    "@font-face { src: url(a.woff2); unicode-range: U+0-7F; }",
  ])("refuses a block that is not complete: %s", (css) => {
    expect(() => readFontFaces(css)).toThrow(/needs a font-family/);
  });
});

describe("faceFor", () => {
  const faces = readFontFaces(CSS);
  const everything = (): boolean => true;
  const [first, second] = faces as [FontFace, FontFace];

  it("takes the last face whose range holds the character (CSS Fonts 4, 4.5.1)", () => {
    expect(faceFor(faces, 0x41, everything)).toBe(second);
    expect(faceFor(faces, 0x61, everything)).toBe(first);
    expect(faceFor(faces, 0x995, everything)).toBe(second);
    expect(faceFor(faces, 0x2192, everything)).toBeNull();
  });

  it("goes on to an earlier face when the later font has no glyph (CSS Fonts 4, 5)", () => {
    const noGlyphInB = (face: FontFace): boolean => face !== second;
    expect(faceFor(faces, 0x41, noGlyphInB)).toBe(first);
    expect(faceFor(faces, 0x995, noGlyphInB)).toBeNull();
  });
});

describe("the real Fontsource stylesheets", () => {
  it("Open Sans lists 10 subsets and Noto Sans Bengali lists 3, each with one file and its own range", () => {
    const css = (pkg: string): string =>
      readFileSync(join(fontPackageDir(`@fontsource-variable/${pkg}`), "index.css"), "utf8");
    const sans = readFontFaces(css("open-sans"));
    const noto = readFontFaces(css("noto-sans-bengali"));
    expect(sans).toHaveLength(10);
    expect(noto.map((f) => f.url)).toEqual([
      "./files/noto-sans-bengali-bengali-wght-normal.woff2",
      "./files/noto-sans-bengali-latin-ext-wght-normal.woff2",
      "./files/noto-sans-bengali-latin-wght-normal.woff2",
    ]);
    expect(new Set(sans.map((f) => f.weight))).toEqual(new Set(["300 800"]));
    expect(new Set(noto.map((f) => f.weight))).toEqual(new Set(["100 900"]));
  });
});
