import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handler } from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(join(here, name), "utf8") }));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("invoice-renderer boundaries", () => {
  it("sees the production files", () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["handler.ts", "engines.ts", "fake.ts", "index.ts"]),
    );
  });
  it("never imports AWS code, the database or a PDF library (R1, R2, R17)", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toMatch(
        /@tc\/aws|@tc\/db|@aws-sdk|puppeteer|playwright|chromium-|pdfkit|jspdf/,
      );
    }
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@tc/core"]);
  });
  it("the lazy wrapper fails closed while the engine and the bucket are not linked (R16)", async () => {
    await expect(handler({})).rejects.toThrow("invoice-renderer: the pdf engine is not linked");
  });
});
