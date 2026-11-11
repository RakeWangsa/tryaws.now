import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "postcss";
import { scanCssRefs } from "./css-refs.ts";

export type CodePointRange = readonly [start: number, end: number];

export interface FontFace {
  readonly family: string;
  readonly style: string;
  readonly weight: string;
  readonly stretch: string;
  readonly display: string;
  /** The one `url()` of `src`, as written. */
  readonly url: string;
  readonly ranges: readonly CodePointRange[];
}

const MAX_CODE_POINT = 0x10ffff;
const HEX_RANGE = /^U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?$/i;
const WILDCARD = /^U\+([0-9A-F]{0,5}\?{1,6})$/i;

function badRange(part: string, why: string): RangeError {
  return new RangeError(`unicode-range: bad range ${JSON.stringify(part)} (${why})`);
}

function parseUnicodePart(part: string): CodePointRange {
  const hex = HEX_RANGE.exec(part);
  const wildcard = WILDCARD.exec(part);
  let start: number;
  let end: number;
  if (hex !== null) {
    start = Number.parseInt(hex[1] as string, 16);
    end = hex[2] === undefined ? start : Number.parseInt(hex[2], 16);
  } else if (wildcard !== null) {
    const pattern = wildcard[1] as string;
    if (pattern.length > 6) throw badRange(part, "more than 6 digits");
    start = Number.parseInt(pattern.replaceAll("?", "0"), 16);
    end = Number.parseInt(pattern.replaceAll("?", "F"), 16);
  } else {
    throw badRange(part, "not U+hex, U+hex-hex or U+hex??");
  }
  if (end > MAX_CODE_POINT) throw badRange(part, "above U+10FFFF");
  if (start > end) throw badRange(part, "ends before it starts");
  return [start, end];
}

/** The ranges of a `unicode-range` descriptor: `U+0980-09FE,U+200C`, wildcards `U+4??`, any case. */
export function parseUnicodeRange(text: string): CodePointRange[] {
  return text.split(",").map((part) => parseUnicodePart(part.trim()));
}

export function inRanges(ranges: readonly CodePointRange[], codePoint: number): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

const INCOMPLETE = "a @font-face block needs a font-family, one url() in src and a unicode-range";

function unquote(text: string): string {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The `@font-face` blocks of a stylesheet, in source order. */
export function readFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  parse(css).walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== "font-face") return;
    const values = new Map<string, string>();
    rule.walkDecls((decl) => {
      values.set(decl.prop.toLowerCase(), decl.value.trim().replace(/\s+/g, " "));
    });
    const family = unquote(values.get("font-family") ?? "");
    const src = values.get("src");
    const range = values.get("unicode-range");
    if (family === "" || src === undefined || range === undefined) throw new Error(INCOMPLETE);
    const urls = scanCssRefs(`x{y:${src}}`);
    const only = urls[0];
    if (urls.length !== 1 || only === undefined) throw new Error(INCOMPLETE);
    faces.push({
      family,
      style: values.get("font-style") ?? "normal",
      weight: values.get("font-weight") ?? "normal",
      stretch: values.get("font-stretch") ?? "normal",
      display: values.get("font-display") ?? "auto",
      url: only.raw,
      ranges: parseUnicodeRange(range),
    });
  });
  return faces;
}

/**
 * The face a browser draws `codePoint` with: the composite-face rule of CSS Fonts Level 4 (4.5.1
 * composite faces, 5 font matching; section numbers to be confirmed). Faces with the same family
 * and identical style, weight and stretch form one composite face; where ranges overlap the last
 * defined face is checked first; a face is used only if its font has the glyph.
 * The caller passes the faces of one composite face.
 */
export function faceFor(
  faces: readonly FontFace[],
  codePoint: number,
  hasGlyph: (face: FontFace, codePoint: number) => boolean,
): FontFace | null {
  for (let i = faces.length - 1; i >= 0; i -= 1) {
    const face = faces[i] as FontFace;
    if (inRanges(face.ranges, codePoint) && hasGlyph(face, codePoint)) return face;
  }
  return null;
}

/** The folder of an installed package (it must export its `package.json`). */
export function fontPackageDir(packageName: string): string {
  return dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`)));
}
