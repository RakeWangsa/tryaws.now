import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handler } from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts"))
  .map((name) => ({ name, text: readFileSync(join(here, name), "utf8") }));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("kyc-check boundaries (WPU-Y3)", () => {
  it("sees the production files", () => {
    expect(files.map((f) => f.name).sort()).toEqual([
      "config.ts",
      "handler.ts",
      "index.ts",
      "s3.ts",
    ]);
  });

  it("uses the AWS SDK only in s3.ts, and there only HeadObject: no read of content (R1)", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toMatch(/@tc\/aws|@tc\/db|drizzle-orm/);
      if (f.name !== "s3.ts") expect(f.text, f.name).not.toContain("@aws-sdk");
    }
    const s3 = files.find((f) => f.name === "s3.ts")!.text;
    const commands = [...s3.matchAll(/\b([A-Z][A-Za-z]+)Command\b/g)].map((m) => m[1]);
    expect([...new Set(commands)]).toEqual(["HeadObject"]);
    for (const f of files) expect(f.text, f.name).not.toMatch(/sts:|AssumeRole|kms/i);
  });

  it("reads process.env and console only in index.ts (R3, R14)", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toContain("process.env");
      expect(f.text, f.name).not.toContain("console.");
    }
    const index = files.find((f) => f.name === "index.ts")!.text;
    const uses = index.match(/[^\n]*process\.env[^\n]*/g) ?? [];
    expect(uses.length).toBe(1);
    expect(uses[0]).toMatch(/readConfig\(process\.env\)/);
  });

  it("depends on exactly the pinned S3 client and @tc/core (R17)", () => {
    expect(pkg.dependencies).toEqual({
      "@aws-sdk/client-s3": "3.1166.0",
      "@tc/core": "workspace:*",
    });
  });

  it("the lazy wrapper fails closed without the kyc bucket (R16)", async () => {
    const before = process.env["KYC_BUCKET"];
    delete process.env["KYC_BUCKET"];
    try {
      await expect(
        handler(
          {},
          { invokedFunctionArn: "arn:aws:lambda:ap-southeast-1:111122223333:function:k:web" },
        ),
      ).rejects.toThrow("kyc-check: KYC_BUCKET is missing or invalid");
    } finally {
      if (before !== undefined) process.env["KYC_BUCKET"] = before;
    }
  });
});
