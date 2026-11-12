import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WPU-B7 (L4): the web tier and the access-details function count a reveal under different action names,
// so the same customer's one reveal is one hit in each counter and the limit is not halved.
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, "..", "..", "..", p), "utf8");
const actionsOf = (text: string) =>
  [...text.matchAll(/action: "([a-z0-9_.]+)"/g)].map((m) => m[1] as string);

describe("rate limit action names per tier (L4)", () => {
  // The function's table: `"windows_password.reveal": 20,` and so on.
  const fn = [
    ...read("functions/access-details/deps.ts").matchAll(/^ {2}"([a-z_.]+)": \d+,$/gm),
  ].map((m) => m[1] as string);
  const web = [
    ...actionsOf(read("apps/web/app/[locale]/(panel)/servers/[id]/windows-actions.ts")),
    ...actionsOf(read("apps/web/app/[locale]/(panel)/databases/[id]/access-actions.ts")),
    ...actionsOf(read("apps/web/server/bucket-deps.ts")),
  ];
  it("finds the names", () => {
    expect(fn).toContain("windows_password.reveal");
    expect(fn).toContain("bucket_key.create");
    expect(web.length).toBeGreaterThanOrEqual(4);
  });
  it("gives every web name the suffix .web and shares none with the function", () => {
    for (const name of web) {
      expect(name).toMatch(/\.web$/);
      expect(fn).not.toContain(name);
    }
    expect(new Set(web).size).toBe(web.length);
  });
  it("the web name for Windows is the function name plus .web", () => {
    expect(web).toContain("windows_password.reveal.web");
  });
});
