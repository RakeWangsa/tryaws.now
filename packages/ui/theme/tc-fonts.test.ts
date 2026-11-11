import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";
import { refKind, resolveRef, scanCssRefs } from "./css-refs.ts";
import { faceFor, fontPackageDir, readFontFaces, type FontFace } from "./font-faces.ts";
import { woff2CodePoints } from "./woff2.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repoRoot}${path}`, "utf8");
const tc = read("packages/ui/styles/tc.css");
const themeCss = read("design/mockup/template/assets/css/theme.min.css");
const faces = readFontFaces(tc);

const LATIN = "open-sans-latin-wght-normal.woff2";
const LATIN_EXT = "open-sans-latin-ext-wght-normal.woff2";
const BENGALI = "noto-sans-bengali-bengali-wght-normal.woff2";
const packageOf = (face: FontFace): string =>
  basename(face.url).startsWith("noto-sans-bengali-")
    ? "@fontsource-variable/noto-sans-bengali"
    : "@fontsource-variable/open-sans";
const glyphs = new Map<string, ReadonlySet<number>>();
const hasGlyph = (face: FontFace, codePoint: number): boolean => {
  const file = basename(face.url);
  if (!glyphs.has(file))
    glyphs.set(
      file,
      woff2CodePoints(readFileSync(join(fontPackageDir(packageOf(face)), "files", file))),
    );
  return glyphs.get(file)?.has(codePoint) === true;
};
const drawnBy = (codePoint: number): string | null =>
  basename(faceFor(faces, codePoint, hasGlyph)?.url ?? "") || null;

describe("the composite family 'Open Sans' (16.4)", () => {
  it("is three faces of one family, from three self-hosted files, the Bengali face last", () => {
    expect(faces.map((f) => [f.family, basename(f.url)])).toEqual([
      ["Open Sans", LATIN_EXT],
      ["Open Sans", LATIN],
      ["Open Sans", BENGALI],
    ]);
  });

  it("Review Focus 1: every face has the same style, weight, stretch and display", () => {
    // Different descriptors would make a browser pick one face and never reach the others (CSS Fonts 4, 5).
    expect(new Set(faces.map((f) => `${f.style}|${f.weight}|${f.stretch}|${f.display}`))).toEqual(
      new Set(["normal|300 800|normal|swap"]),
    );
  });

  it("takes each unicode-range from the Fontsource stylesheet of the same file, character for character", () => {
    for (const face of faces) {
      const index = readFontFaces(
        readFileSync(join(fontPackageDir(packageOf(face)), "index.css"), "utf8"),
      );
      const same = index.find((f) => basename(f.url) === basename(face.url));
      expect(same, basename(face.url)).toBeDefined();
      expect(face.ranges, basename(face.url)).toEqual(same?.ranges);
    }
  });

  it("is the family that the theme names for the body, headings, buttons and inputs, with !important", () => {
    let rule: { value: string; important: boolean } | undefined;
    parse(themeCss).walkRules((r) => {
      if (r.selectors.includes("body[data-font=opensans] button"))
        r.walkDecls("font-family", (d) => {
          rule = { value: d.value, important: d.important === true };
        });
    });
    expect(rule).toEqual({ value: "'Open Sans',sans-serif", important: true });
  });

  it("draws every Bengali glyph of its range with Noto Sans Bengali", () => {
    const noto = faces[2] as FontFace;
    const all = [
      ...woff2CodePoints(readFileSync(join(fontPackageDir(packageOf(noto)), "files", BENGALI))),
    ];
    const inRange = all.filter((c) => noto.ranges.some(([a, b]) => c >= a && c <= b));
    expect(inRange.length).toBeGreaterThan(110);
    expect(inRange.filter((c) => drawnBy(c) !== BENGALI)).toEqual([]);
    // the taka sign, the Bengali digits 0 and 9, the virama, the danda and both joiners
    for (const c of [0x9f3, 0x9e6, 0x9ef, 0x9cd, 0x964, 0x200c, 0x200d])
      expect(drawnBy(c), `U+${c.toString(16)}`).toBe(BENGALI);
  });

  it("Review Focus 2: Latin text stays in Open Sans, with the latin-ext file for the rest", () => {
    for (let c = 0x20; c <= 0x7e; c++) expect(drawnBy(c), `U+${c.toString(16)}`).toBe(LATIN);
    expect([0xe9, 0x20ac, 0xd7].map(drawnBy)).toEqual([LATIN, LATIN, LATIN]);
    expect([0x101, 0x141].map(drawnBy)).toEqual([LATIN_EXT, LATIN_EXT]);
    expect(drawnBy(0x2192)).toBeNull(); // an arrow is in none of the files: the system font draws it
  });

  it("has a glyph for every character of the Bengali statements and product names of 16.13", () => {
    const texts = [
      "১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।",
      "এখানে কেনা প্রতিটি সার্ভার, ডেটাবেস ও স্টোরেজ একটি Amazon Lightsail resource, যা Singapore বা Mumbai AWS Region থেকে চলে। বিক্রি, বিল ও সাপোর্ট TiCON Cloud দেয়। সবকিছু এই প্যানেল থেকেই চালানো যায়, আলাদা AWS account লাগে না।",
      "ক্লাউড সার্ভার ম্যানেজড ডেটাবেস ব্লক স্টোরেজ অবজেক্ট স্টোরেজ লোড ব্যালান্সার কন্টেইনার সার্ভিস সিডিএন স্ট্যাটিক আইপি ব্যাকআপ প্ল্যান ইমেজ লোকেশন ডিএনএস, ডোমেইন টপ আপ AWS সার্ভিস মূল্য",
      "৳ ১,২৩৪.৫০ ০১৭১২৩৪৫৬৭৮৯",
    ];
    const missing = texts.flatMap((t) =>
      [...t].filter((ch) => ch !== " " && drawnBy(ch.codePointAt(0) ?? 0) === null),
    );
    expect(missing).toEqual([]);
  });

  it("names no other origin, imports nothing, and every url() is a font file beside tc.css (U3)", () => {
    const refs = scanCssRefs(tc);
    expect(refs.filter((r) => r.kind === "import")).toEqual([]);
    expect(refs.map((r) => refKind(r.raw))).toEqual(["relative", "relative", "relative"]);
    expect(refs.map((r) => resolveRef("tc.css", r.raw))).toEqual([
      `fonts/${LATIN_EXT}`,
      `fonts/${LATIN}`,
      `fonts/${BENGALI}`,
    ]);
  });
});
