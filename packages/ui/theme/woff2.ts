import { brotliDecompressSync } from "node:zlib";

// WOFF2 (W3C) header and table directory, and the OpenType `cmap` table. Only what is needed to
// answer "which code points has this font a glyph for". Anything unreadable throws an Error whose
// message starts with `woff2:` (R16, fail closed).

const HEADER_SIZE = 48;
const SIGNATURE = 0x774f4632; // "wOF2"
const COLLECTION_FLAVOR = 0x74746366; // "ttcf"
const KNOWN_TABLE_CMAP = 0;
const KNOWN_TABLE_GLYF = 10;
const KNOWN_TABLE_LOCA = 11;
const CUSTOM_TAG = 63;
const MAX_CODE_POINT = 0x10ffff;

function fail(message: string): never {
  throw new Error(`woff2: ${message}`);
}

/** Bounds-checked big-endian reads over a byte array. */
class Reader {
  readonly #view: DataView;
  readonly #name: string;

  constructor(bytes: Uint8Array, name: string) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#name = name;
  }

  get length(): number {
    return this.#view.byteLength;
  }

  u8(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset + 1 > this.length) this.#outside(offset);
    return this.#view.getUint8(offset);
  }

  u16(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset + 2 > this.length) this.#outside(offset);
    return this.#view.getUint16(offset);
  }

  i16(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset + 2 > this.length) this.#outside(offset);
    return this.#view.getInt16(offset);
  }

  u32(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > this.length) this.#outside(offset);
    return this.#view.getUint32(offset);
  }

  #outside(offset: number): never {
    return fail(`${this.#name} is cut short (read at ${offset} of ${this.length})`);
  }
}

/** UIntBase128: 1 to 5 bytes, 7 bits each, high bit set on all but the last. */
function readBase128(reader: Reader, start: number): { value: number; next: number } {
  let accum = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = reader.u8(start + i);
    if (i === 0 && byte === 0x80) fail("bad number (leading zero byte)");
    if (accum > 0x1ffffff) fail("bad number (overflow)");
    accum = accum * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      if (accum > 0xffffffff) fail("bad number (overflow)");
      return { value: accum, next: start + i + 1 };
    }
  }
  return fail("bad number (more than 5 bytes)");
}

interface DirectoryEntry {
  readonly isCmap: boolean;
  readonly streamLength: number;
  readonly transformed: boolean;
}

function readDirectory(
  reader: Reader,
  numTables: number,
): { entries: DirectoryEntry[]; end: number } {
  const entries: DirectoryEntry[] = [];
  let at = HEADER_SIZE;
  for (let i = 0; i < numTables; i += 1) {
    const flags = reader.u8(at);
    at += 1;
    const knownIndex = flags & 0x3f;
    const version = flags >> 6;
    let tag: string | null = null;
    if (knownIndex === CUSTOM_TAG) {
      let text = "";
      for (let k = 0; k < 4; k += 1) text += String.fromCharCode(reader.u8(at + k));
      tag = text;
      at += 4;
    }
    const isGlyfOrLoca =
      tag === null
        ? knownIndex === KNOWN_TABLE_GLYF || knownIndex === KNOWN_TABLE_LOCA
        : tag === "glyf" || tag === "loca";
    const isCmap = tag === null ? knownIndex === KNOWN_TABLE_CMAP : tag === "cmap";
    const original = readBase128(reader, at);
    at = original.next;
    // glyf and loca are transformed at version 0; every other table at a version other than 0.
    const transformed = isGlyfOrLoca ? version === 0 : version !== 0;
    let streamLength = original.value;
    if (transformed) {
      const transform = readBase128(reader, at);
      at = transform.next;
      streamLength = transform.value;
    }
    entries.push({ isCmap, streamLength, transformed });
  }
  return { entries, end: at };
}

function readFormat4(cmap: Reader, base: number, into: Set<number>): void {
  const segCountX2 = cmap.u16(base + 6);
  if (segCountX2 % 2 !== 0) fail("cmap format 4 has an odd segCountX2");
  const segCount = segCountX2 / 2;
  const endCodes = base + 14;
  const startCodes = endCodes + segCountX2 + 2; // one reserved uint16 between the arrays
  const deltas = startCodes + segCountX2;
  const rangeOffsets = deltas + segCountX2;
  for (let i = 0; i < segCount; i += 1) {
    const end = cmap.u16(endCodes + i * 2);
    const start = cmap.u16(startCodes + i * 2);
    const delta = cmap.i16(deltas + i * 2);
    const rangeOffsetAt = rangeOffsets + i * 2;
    const rangeOffset = cmap.u16(rangeOffsetAt);
    if (start > end) fail("cmap format 4 has a segment that ends before it starts");
    for (let code = start; code <= end; code += 1) {
      if (code === 0xffff) continue; // the closing segment maps no real character
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const raw = cmap.u16(rangeOffsetAt + rangeOffset + (code - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) into.add(code);
    }
  }
}

function readFormat12(cmap: Reader, base: number, into: Set<number>): void {
  const numGroups = cmap.u32(base + 12);
  for (let i = 0; i < numGroups; i += 1) {
    const at = base + 16 + i * 12;
    const start = cmap.u32(at);
    const end = cmap.u32(at + 4);
    const startGlyph = cmap.u32(at + 8);
    if (start > end || end > MAX_CODE_POINT) fail("cmap format 12 has a bad group");
    // Only the first character of a group can have glyph 0 (when the group starts at glyph 0).
    for (let code = start; code <= end; code += 1) {
      if (startGlyph + (code - start) !== 0) into.add(code);
    }
  }
}

function readCmap(table: Uint8Array): Set<number> {
  const cmap = new Reader(table, "cmap");
  const numRecords = cmap.u16(2);
  const codes = new Set<number>();
  let usable = 0;
  for (let i = 0; i < numRecords; i += 1) {
    const platform = cmap.u16(4 + i * 8);
    if (platform !== 0 && platform !== 3) continue;
    const base = cmap.u32(4 + i * 8 + 4);
    const format = cmap.u16(base);
    if (format === 4) readFormat4(cmap, base, codes);
    else if (format === 12) readFormat12(cmap, base, codes);
    else continue;
    usable += 1;
  }
  if (usable === 0) fail("no cmap subtable of platform 0 or 3 in format 4 or 12");
  return codes;
}

/**
 * Every code point that has a glyph (glyph index other than 0) in a `cmap` subtable of platform 0
 * or 3, format 4 or 12, of a WOFF2 file.
 */
export function woff2CodePoints(bytes: Uint8Array): ReadonlySet<number> {
  if (bytes.length < 4) fail("bad signature");
  const reader = new Reader(bytes, "file");
  if (reader.u32(0) !== SIGNATURE) fail("bad signature");
  if (bytes.length < HEADER_SIZE) fail("header is cut short");
  if (reader.u32(4) === COLLECTION_FLAVOR) fail("font collections are not supported");

  const numTables = reader.u16(12);
  const compressedSize = reader.u32(20);
  if (numTables === 0) fail("no tables");

  const { entries, end } = readDirectory(reader, numTables);
  if (end + compressedSize > bytes.length) fail("compressed data is cut short");

  let stream: Uint8Array;
  try {
    stream = brotliDecompressSync(bytes.subarray(end, end + compressedSize));
  } catch (error) {
    throw new Error("woff2: the compressed data cannot be decompressed", { cause: error });
  }

  let total = 0;
  let cmapAt = -1;
  let cmapEntry: DirectoryEntry | undefined;
  for (const entry of entries) {
    if (entry.isCmap && cmapEntry === undefined) {
      cmapEntry = entry;
      cmapAt = total;
    }
    total += entry.streamLength;
  }
  if (total !== stream.length) fail("table lengths do not add up to the decompressed data");
  if (cmapEntry === undefined) fail("no cmap table");
  if (cmapEntry.transformed) fail("cmap has an unknown transform");

  return readCmap(stream.subarray(cmapAt, cmapAt + cmapEntry.streamLength));
}
