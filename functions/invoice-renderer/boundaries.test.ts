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
  it("imports AWS code, the database or a PDF library only in engines.ts (R1, R2, R17)", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toMatch(/@tc\/aws|@tc\/db|pdfkit|jspdf|playwright/);
      if (f.name === "engines.ts") continue;
      expect(f.text, f.name).not.toMatch(/@aws-sdk|puppeteer|chromium/);
    }
    // R17: the three dependencies of WPU-D1 are pinned to exact versions
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@aws-sdk/client-s3",
      "@sparticuz/chromium",
      "@tc/core",
      "puppeteer-core",
    ]);
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name !== "@tc/core") expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
  it("the lazy wrapper fails closed without the invoices bucket (R16)", async () => {
    const before = process.env["INVOICES_BUCKET"];
    delete process.env["INVOICES_BUCKET"];
    try {
      await expect(handler({})).rejects.toThrow(
        "invoice-renderer: the invoices bucket is not configured",
      );
    } finally {
      if (before !== undefined) process.env["INVOICES_BUCKET"] = before;
    }
  });
});
