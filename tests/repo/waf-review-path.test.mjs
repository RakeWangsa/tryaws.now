// WPU-X20: the Common rule set rule SizeRestrictions_QUERYSTRING blocked /orders/review?d=<domain draft> (2.6 KB).
// Proven by reading infra/stacks/waf.ts (SST cannot run here); comments are removed first.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const waf = readFileSync(resolve(root, "infra/stacks/waf.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|\s)\/\/.*$/gm, "$1")
  .replace(/\s+/g, " ");

describe("WAF: long query string on the review path only", () => {
  it("overrides only SizeRestrictions_QUERYSTRING, to Count, in a scoped copy of the Common group", () => {
    expect(waf).toContain('const SIZE_RESTRICTIONS_QUERYSTRING = "SizeRestrictions_QUERYSTRING"');
    const overrides = [...waf.matchAll(/ruleActionOverrides/g)];
    expect(overrides).toHaveLength(1);
    expect(waf).toMatch(
      /ruleActionOverrides: \[\{ name: SIZE_RESTRICTIONS_QUERYSTRING, actionToUse: \{ count: \{\} \} \}\]/,
    );
    expect(waf).toContain("scopeDownStatement: isReviewPath");
    expect(waf).not.toMatch(/actionToUse: \{ allow/);
  });
  it("the unchanged Common group skips that path, so every request meets the group once", () => {
    expect(waf).toMatch(
      /managedGroup\(name, priority, \{ notStatement: \{ statements: \[isReviewPath\] \} \}\)/,
    );
    expect(waf).toContain("customerManagedGroup(group.name, group.priority)");
    expect(waf).toContain("reviewPathCommonGroup(15)");
  });
  it("covers the review path and the top-up path that carries it, with and without a slash, and nothing else", () => {
    expect(waf).toContain('LONG_QUERY_PATHS = ["/orders/review", "/wallet/topup"]');
    expect(waf).toContain('positionalConstraint: "ENDS_WITH"');
    expect(waf).toMatch(/pathEndsWith\(path\), pathEndsWith\(`\$\{path\}\/`\)/);
  });
  it("the admin ACL keeps the plain managed groups", () => {
    expect(waf).toMatch(
      /outsideAllowlist,\s*\.\.\.managed\.map\(\(group\) => managedGroup\(group\.name, group\.priority\)\)/,
    );
  });
});
