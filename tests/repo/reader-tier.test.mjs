import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// WPU-S6: the reader takes the caller kind from the alias that was invoked; the infra grants each tier
// only its own alias. The text of the stacks is the proof that no role holds the bare function ARN.
const read = (p) => readFileSync(resolve(import.meta.dirname, "../..", p), "utf8");

describe("reader tier aliases (WPU-S6)", () => {
  const web = read("infra/stacks/web.ts");
  const workers = read("infra/stacks/workers.ts");

  it("creates a web and an admin alias of the reader on a published version", () => {
    expect(workers).toMatch(/\(\["web", "admin"\] as const\)/);
    expect(workers).toMatch(/new aws\.lambda\.Alias\(/);
    expect(workers).toMatch(/args\.publish = true/);
  });

  it("grants the web role the web alias and the admin role the admin alias, never the bare function", () => {
    expect(web).toMatch(/workers\.readerAliases\.web\.arn/);
    expect(web).toMatch(/workers\.readerAliases\.admin\.arn/);
    expect(web).not.toMatch(/invoke\("reader"/);
    expect(web.match(/readerAliases\.web/g)).toHaveLength(1);
    expect(web.match(/readerAliases\.admin/g)).toHaveLength(1);
  });

  it("the web port invokes the web alias", () => {
    expect(read("apps/web/server/reader-invoke.ts")).toMatch(/Qualifier: READER_WEB_ALIAS/);
  });
});
