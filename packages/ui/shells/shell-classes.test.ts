import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tcCss = readFileSync(resolve(here, "../styles/tc.css"), "utf8");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "messages") out.push(...sources(path));
    } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      if (entry.name !== "test-utils.tsx") out.push(path);
    }
  }
  return out;
}

function definedClasses(): Set<string> {
  const defined = new Set<string>();
  postcss.parse(tcCss).walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      defined.add(match[1] as string);
    }
  });
  return defined;
}

describe("shell classes", () => {
  it("every tc- class used in packages/ui/shells/**/*.tsx is defined in tc.css", () => {
    const files = sources(here);
    expect(files.length).toBeGreaterThan(0);
    const defined = definedClasses();
    const missing: string[] = [];
    for (const file of files) {
      for (const token of readFileSync(file, "utf8").match(/(?<![\w-])tc-[a-z0-9-]+/g) ?? []) {
        if (!defined.has(token)) missing.push(`${token} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("tc.css has a focus-within rule for the product dropdown", () => {
    let found = false;
    postcss.parse(tcCss).walkRules((rule) => {
      if (rule.selector.includes(".menu-item-has-children:focus-within")) found = true;
    });
    expect(found).toBe(true);
  });

  it("tc.css has the block 7a header", () => {
    expect(tcCss).toContain("/* ---- 7a. PublicShell and AuthShell (WPU-T4) ---- */");
  });
});
