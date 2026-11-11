import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function sources(): { name: string; text: string }[] {
  return readdirSync(here, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.endsWith(".d.ts"),
    )
    .map((e) => ({ name: e.name, text: readFileSync(join(here, e.name), "utf8") }));
}

describe("reader boundaries", () => {
  const files = sources();

  it("sees the production files", () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["handler.ts", "invoke.ts", "config.ts", "deps.ts", "index.ts"]),
    );
  });

  it("calls AWS only through the read source of @tc/aws and never imports the SDK (R1, R3)", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toContain("@aws-sdk");
      expect(f.text, f.name).not.toMatch(
        /\b(Assume|GetInstance|PutInstance|Create|Delete)\w*Command\b/,
      );
    }
  });

  it("asks only for the caller `reader` and never for a role that writes (R3)", () => {
    const all = files.map((f) => f.text).join("\n");
    expect(all).toContain('caller: "reader"');
    for (const role of ["TcProvisioner", "TcAccessDetails", "provisioner", "access-details"]) {
      expect(all).not.toContain(role);
    }
  });

  it("reads process.env only in index.ts, only to hand it to readConfig (R3)", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toContain("process.env");
    }
    const index = files.find((f) => f.name === "index.ts")!.text;
    const uses = index.match(/[^\n]*process\.env[^\n]*/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/readConfig\(process\.env\)/);
  });

  it("uses console only in index.ts (R14)", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toContain("console.");
    }
    const index = files.find((f) => f.name === "index.ts")!.text;
    expect(index.match(/console\./g) ?? []).toHaveLength(1);
  });

  it("holds no write to the database and no raw SQL: it reads through loadReadTarget only", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toMatch(/\b(tx|db)\.(insert|update|delete|execute)\b/);
      expect(f.text, f.name).not.toContain("sql`");
      expect(f.text, f.name).not.toContain("drizzle-orm");
    }
  });

  it("depends on exactly @tc/aws, @tc/core and @tc/db (R17)", () => {
    const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@tc/aws", "@tc/core", "@tc/db"]);
  });
});
