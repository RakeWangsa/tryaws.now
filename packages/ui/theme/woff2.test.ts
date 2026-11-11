import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fontPackageDir } from "./font-faces.ts";
import { woff2CodePoints } from "./woff2.ts";

const load = (pkg: string, file: string): Uint8Array =>
  readFileSync(join(fontPackageDir(`@fontsource-variable/${pkg}`), "files", file));
const bengali = load("noto-sans-bengali", "noto-sans-bengali-bengali-wght-normal.woff2");
const latin = load("open-sans", "open-sans-latin-wght-normal.woff2");
const latinExt = load("open-sans", "open-sans-latin-ext-wght-normal.woff2");
const has = (set: ReadonlySet<number>, codes: number[]): boolean[] => codes.map((c) => set.has(c));

describe("woff2CodePoints (Fontsource 5.3.0 files)", () => {
  it("Noto Sans Bengali has the letters, the digits, the taka sign, the virama and the joiners", () => {
    const set = woff2CodePoints(bengali);
    // ক, ৳ (taka), ০, ৯, ্ (virama), ।, ZWNJ, ZWJ, dotted circle, ₹
    expect(
      has(set, [0x995, 0x9f3, 0x9e6, 0x9ef, 0x9cd, 0x964, 0x200c, 0x200d, 0x25cc, 0x20b9]),
    ).toEqual(Array(10).fill(true));
    expect(has(set, [0x41, 0x7a, 0x30, 0x9ff, 0x2192])).toEqual(Array(5).fill(false));
    expect([...set].filter((c) => c >= 0x980 && c <= 0x9ff).length).toBeGreaterThan(90);
  });

  it("Open Sans latin has Latin letters, digits, accents and the euro sign, and nothing Bengali", () => {
    const set = woff2CodePoints(latin);
    expect(has(set, [0x41, 0x7a, 0x30, 0x39, 0xe9, 0x20ac])).toEqual(Array(6).fill(true));
    expect(has(set, [0x995, 0x9f3, 0x200d, 0x2192])).toEqual(Array(4).fill(false));
  });

  it("Open Sans latin-ext has letters that latin lacks", () => {
    expect(has(woff2CodePoints(latinExt), [0x101, 0x141])).toEqual([true, true]);
    expect(has(woff2CodePoints(latin), [0x101, 0x141])).toEqual([false, false]);
  });

  it("refuses a file that is not WOFF2, an empty file and a file cut short", () => {
    expect(() => woff2CodePoints(Uint8Array.of(1, 2, 3))).toThrow("woff2: bad signature");
    expect(() => woff2CodePoints(new Uint8Array(0))).toThrow("woff2: bad signature");
    const wrong = Uint8Array.from(bengali);
    wrong[0] = 0x58;
    expect(() => woff2CodePoints(wrong)).toThrow("woff2: bad signature");
    expect(() => woff2CodePoints(bengali.subarray(0, 4000))).toThrow();
    expect(() => woff2CodePoints(bengali.subarray(0, 60))).toThrow();
  });
});
