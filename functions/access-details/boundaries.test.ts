import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
  .map((e) => ({ name: e.name, text: readFileSync(join(here, e.name), "utf8") }));

describe("access-details boundaries", () => {
  it("sees the production files", () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["handler.ts", "invoke.ts", "deps.ts", "index.ts"]),
    );
  });

  it("calls AWS only through @tc/aws and never imports the SDK (R1, R3)", () => {
    for (const f of files) expect(f.text, f.name).not.toContain("@aws-sdk");
  });

  it("asks only for the caller access-details and never downloads a key pair (R3)", () => {
    const all = files.map((f) => f.text).join("\n");
    expect(all).toContain('caller: "access-details"');
    expect(all).not.toMatch(/DownloadDefaultKeyPair|caller: "provisioner"/);
  });

  it("never writes the secret anywhere: no storage, no console but the fixed log in index.ts", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toMatch(/console\./);
    }
    const handler = files.find((f) => f.name === "handler.ts")!.text;
    // the log call carries three fixed words and nothing of the result
    expect(handler).toMatch(
      /deps\.log\(\{ event: "access_details", action: "windows_password", outcome \}\)/,
    );
  });
});
