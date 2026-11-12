import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WP9-T4: the runbooks of Section M. Every page listed in the README exists, every page of the folder is
// listed, every `pnpm ...` command cited in backticks names a script of the root package.json, the
// "walked through" column is empty until the owner fills it (nobody is claimed to have walked), and no
// page contains something that looks like a secret value.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "docs", "runbooks");
const read = (name) => readFileSync(join(dir, name), "utf8");
const pages = readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "README.md");
const readme = read("README.md");
const scripts = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts);

// A command of pnpm that is not a script of ours.
const PNPM_BUILTINS = new Set(["install", "audit"]);

describe("runbooks index", () => {
  const [, indexPart, walkedPart] = readme.split(/^## (?:Index|Walked through once)$/m);

  it("lists every page of the folder, and every listed page exists", () => {
    const listed = [...indexPart.matchAll(/\]\(([^)#]+\.md)\)/g)].map((m) => m[1]);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...pages].sort());
    expect(pages.length).toBeGreaterThanOrEqual(15);
  });

  it("has a walked-through table with every page and an empty date column", () => {
    const rows = walkedPart.split("\n").filter((l) => /^\|.*\.md\)/.test(l));
    expect(rows.length).toBe(pages.length);
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1);
      expect(cells.length).toBe(2);
      expect(cells[1].trim()).toBe("");
    }
    expect(walkedPart).toMatch(/walked through \(date, by whom\)/);
  });

  it("links the restore drill that WP9-T3 wrote and does not rewrite it", () => {
    expect(readme).toContain("(restore-drill.md)");
    expect(read("restore-drill.md")).toMatch(/^# Restore drill \(WP9-T3\)/);
  });
});

describe("runbook commands and rules", () => {
  it("every `pnpm ...` command in backticks names a script of package.json", () => {
    const cited = [];
    for (const name of ["README.md", ...pages]) {
      for (const m of read(name).matchAll(/`(pnpm [^`]+)`/g)) cited.push([name, m[1]]);
    }
    expect(cited.length).toBeGreaterThan(0);
    for (const [name, cmd] of cited) {
      const word = cmd.split(/\s+/)[1];
      expect(
        scripts.includes(word) || PNPM_BUILTINS.has(word),
        `${name}: \`${cmd}\` names no script of package.json`,
      ).toBe(true);
    }
  });

  it("every `node scripts/...` file cited exists", () => {
    for (const name of ["README.md", ...pages]) {
      for (const m of read(name).matchAll(/`node (scripts\/[^\s`]+)/g)) {
        expect(() => readFileSync(join(root, m[1])), `${name}: ${m[1]}`).not.toThrow();
      }
    }
  });

  it("every page has the sections of an operational page", () => {
    for (const name of pages.filter((n) => n !== "restore-drill.md")) {
      const text = read(name);
      expect(text, name).toMatch(/^# /m);
      expect(text, name).toMatch(/^## Trigger$/m);
      expect(text, name).toMatch(/^## Must not$/m);
    }
  });

  it("holds no secret-looking value", () => {
    for (const name of ["README.md", ...pages]) {
      const text = read(name);
      expect(text, name).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(text, name).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, name).not.toMatch(/\b\d{12}\b/); // an AWS account id
      expect(text, name).not.toMatch(/arn:aws:/);
    }
  });
});
