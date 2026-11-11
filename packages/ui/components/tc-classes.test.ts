import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classSelectorTokens } from "../test/class-inventory";

const here = fileURLToPath(new URL("./", import.meta.url));
const tcCss = readFileSync(fileURLToPath(new URL("../styles/tc.css", import.meta.url)), "utf8");

const componentFiles = readdirSync(here)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .sort();
const usedByComponents = new Set<string>();
const usedIn = new Map<string, string[]>();
for (const file of componentFiles) {
  const text = readFileSync(`${here}${file}`, "utf8");
  for (const token of text.match(/(?<![\w-])tc-[a-z0-9-]+/g) ?? []) {
    usedByComponents.add(token);
    usedIn.set(token, [...(usedIn.get(token) ?? []), file]);
  }
}

/** The text of tc.css between the first marker `from` and the first marker `to`. */
function between(from: string, to: string): string {
  const start = tcCss.indexOf(from);
  const end = tcCss.indexOf(to, start + 1);
  expect(start, `tc.css has the marker ${from}`).toBeGreaterThanOrEqual(0);
  expect(end, `tc.css has the marker ${to}`).toBeGreaterThan(start);
  return tcCss.slice(start, end);
}

describe("tc-* classes", () => {
  it("every tc-* class a component names is defined in tc.css", () => {
    const defined = new Set(classSelectorTokens(tcCss));
    const missing = [...usedByComponents]
      .filter((token) => !defined.has(token))
      .map((token) => `${token} (${(usedIn.get(token) ?? []).join(", ")})`);
    expect(missing, "tc-* classes used by components but not defined in tc.css").toEqual([]);
  });

  it("every .tc-* class of the kit sections 5 and 6 is used by a component (no dead rule)", () => {
    const kitCss = between("/* ===== 5.1", "/* ===== 7");
    const dead = [...new Set(classSelectorTokens(kitCss).filter((t) => t.startsWith("tc-")))]
      .filter((token) => !usedByComponents.has(token))
      .sort();
    expect(dead, "tc-* classes defined in sections 5 and 6 but used by no component").toEqual([]);
  });

  it("tc.css has the sub-block headers of the kit in order", () => {
    const headers = [...tcCss.matchAll(/^\/\* ===== ([56]\.\d) [^=]*===== \*\/$/gm)].map(
      (m) => m[1],
    );
    expect(headers).toEqual([
      "5.1",
      "5.2",
      "5.3",
      "5.4",
      "5.5",
      "6.1",
      "6.2",
      "6.3",
      "6.4",
      "6.5",
      "6.6",
    ]);
  });
});
