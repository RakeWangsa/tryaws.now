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

describe("payments-sweeper boundaries", () => {
  const files = sources();

  it("sees the production files", () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        "handler.ts",
        "alert.ts",
        "config.ts",
        "secrets.ts",
        "deps.ts",
        "index.ts",
      ]),
    );
  });

  it("never imports AWS code (R1)", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toContain("@tc/aws");
      expect(f.text, f.name).not.toContain("@aws-sdk");
    }
  });

  it("reads process.env only in index.ts, and only to hand it to readConfig (R3)", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toContain("process.env");
    }
    const index = files.find((f) => f.name === "index.ts")!.text;
    const uses = index.match(/[^\n]*process\.env[^\n]*/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/readConfig\(process\.env\)/);
      expect(u).not.toMatch(/Eps[A-Z]|EPS_(PASSWORD|USERNAME|HASH|MERCHANT|STORE)/i);
    }
    expect(index).not.toMatch(/process\.env\./);
    expect(index).not.toMatch(/process\.env\[/);
  });

  it("does no float or lossy number work near money (R4)", () => {
    for (const f of files) {
      for (const bad of ["Number(", "parseFloat(", "parseInt(", "toFixed"]) {
        expect(f.text, `${f.name} ${bad}`).not.toContain(bad);
      }
    }
  });

  it("uses console only in index.ts (R14)", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toContain("console.");
    }
    const index = files.find((f) => f.name === "index.ts")!.text;
    expect(index.match(/console\./g) ?? []).toHaveLength(1);
  });

  it("never runs sst secret", () => {
    for (const f of files) expect(f.text, f.name).not.toContain("sst secret");
  });

  it("depends on exactly @tc/core, @tc/db and @tc/eps (R17)", () => {
    const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@tc/core", "@tc/db", "@tc/eps"]);
  });
});
