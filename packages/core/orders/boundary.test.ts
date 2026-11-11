import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const core = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      entry.name !== "testkit.ts"
    )
      out.push(path);
  }
  return out.sort();
}

const files = [...sources(join(core, "orders")), ...sources(join(core, "products"))];
const MONEY_FILES = new Set(["purchase.ts", "compare.ts", "compensate.ts", "place.ts"]);

/** The module specifiers of every import, export-from, dynamic import and require in a source. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[1] as string);
  return found;
}

const FORBIDDEN = [
  /^@tc\/aws(\/|$)/,
  /^@tc\/auth(\/|$)/,
  /^@tc\/notify(\/|$)/,
  /^aws-sdk(\/|$)/,
  /^@aws-sdk\//,
  /(^|\/)apps\//,
  /^next(\/|$)/,
];

describe("the boundary of packages/core/orders and packages/core/products", () => {
  it("scans real files (the scan itself cannot pass on an empty list)", () => {
    const names = files.map((f) => relative(core, f));
    expect(names).toEqual(
      expect.arrayContaining([
        "orders/purchase.ts",
        "orders/compare.ts",
        "orders/compensate.ts",
        "orders/place.ts",
        "orders/index.ts",
        "products/instance.ts",
      ]),
    );
    expect(names.some((n) => n.endsWith(".test.ts") || n.endsWith("testkit.ts"))).toBe(false);
  });

  it("imports no AWS, auth, notify, app or Next.js module (R1, pure logic)", () => {
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        for (const re of FORBIDDEN)
          expect(re.test(spec), `${relative(core, file)} imports ${spec}`).toBe(false);
      }
    }
  });

  it("does not use Number( or parseFloat in a file that handles money (R4)", () => {
    for (const file of files.filter((f) => MONEY_FILES.has(f.slice(f.lastIndexOf("/") + 1)))) {
      const source = readFileSync(file, "utf8");
      expect(/\bNumber\s*\(/.test(source), `${relative(core, file)}: Number(`).toBe(false);
      expect(/\bparseFloat\b/.test(source), `${relative(core, file)}: parseFloat`).toBe(false);
    }
  });

  it("makes no console call and reads no process.env (R3, R14)", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(/\bconsole\s*\./.test(source), `${relative(core, file)}: console.`).toBe(false);
      expect(/\bprocess\s*\.\s*env\b/.test(source), `${relative(core, file)}: process.env`).toBe(
        false,
      );
    }
  });
});
