import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Next 16.4.6 with `next start --hostname 127.0.0.1` answers a self-redirect (307) on every path of
// the default locale: NextURL rewrites 127.x.x.x to localhost, so the router takes the rewrite of
// the proxy for an external one. The smoke script must not start the server that way.
describe("smoke script: server hostname", () => {
  const source = readFileSync(join(import.meta.dirname, "../../scripts/smoke-apps.mjs"), "utf8");

  it("does not pass a numeric loopback address to next start", () => {
    expect(source).not.toMatch(/http:\/\/127\./);
    expect(source).not.toMatch(/"--hostname",\s*"127\./);
    expect(source).toContain('const HOSTNAME = "localhost";');
  });
});
