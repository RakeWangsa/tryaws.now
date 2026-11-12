import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forbiddenWording, messageKeys, missingKeys } from "./message-checks.ts";
import { shellMessages } from "./messages/index.ts";
import type { Messages } from "../runtime/index.ts";
import type { AdminNavId, AppNavId } from "./types.ts";

const specPath = fileURLToPath(
  new URL("../../../docs/spec/16/16.13-states-wording-and-formats.md", import.meta.url),
);

function leaf(tree: Messages, dotted: string): string {
  let node: string | Messages = tree;
  for (const part of dotted.split(".")) {
    if (typeof node === "string") throw new Error(`not a branch before ${dotted}`);
    const next: string | Messages | undefined = node[part];
    if (next === undefined) throw new Error(`missing key ${dotted}`);
    node = next;
  }
  if (typeof node !== "string") throw new Error(`${dotted} is not a leaf`);
  return node;
}

function specRow(markdown: string, label: string): { en: string; bn: string } {
  const line = markdown.split("\n").find((l) => l.startsWith(`| ${label} |`));
  if (line === undefined) throw new Error(`row not found in 16.13: ${label}`);
  const cells = line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  const [, en, bn] = cells;
  if (en === undefined || bn === undefined) throw new Error(`row has no two statements: ${label}`);
  // WPU-B1: docs/spec/16.13 still names the old brand (the plan is edited in its own pull request); the
  // statements are compared with the brand of the product.
  const brand = (text: string): string => text.replaceAll("TiCON Cloud", "MeghVPS");
  return { en: brand(en), bn: brand(bn) };
}

describe("shellMessages", () => {
  const { bn, en } = shellMessages;

  it("bn and en have the same keys", () => {
    expect(missingKeys(bn, en)).toEqual([]);
    expect(missingKeys(en, bn)).toEqual([]);
    expect(messageKeys(bn).length).toBeGreaterThan(60);
  });

  it("every leaf is a non-empty string", () => {
    for (const tree of [bn, en]) {
      for (const key of messageKeys(tree)) {
        expect(leaf(tree, key).trim().length, key).toBeGreaterThan(0);
      }
    }
  });

  it("Aws.short, Aws.long and Aws.trademark equal the strings of 16.13 in both locales", () => {
    const markdown = readFileSync(specPath, "utf8");
    const short = specRow(markdown, "Short statement: hero, footers, emails");
    const long = specRow(markdown, "Long statement: landing page, product pages, FAQ");
    const trademark = specRow(markdown, "Trademark line: footers of pages and emails");
    expect(short.en.length).toBeGreaterThan(20);
    expect(long.bn.length).toBeGreaterThan(100);
    expect(leaf(en, "Aws.short")).toBe(short.en);
    expect(leaf(bn, "Aws.short")).toBe(short.bn);
    expect(leaf(en, "Aws.long")).toBe(long.en);
    expect(leaf(bn, "Aws.long")).toBe(long.bn);
    expect(trademark.bn).toBe("The same line in English");
    expect(leaf(en, "Aws.trademark")).toBe(trademark.en);
    expect(leaf(bn, "Aws.trademark")).toBe(trademark.en);
  });

  it("has no forbidden wording in any shell message", () => {
    expect(forbiddenWording(bn)).toEqual([]);
    expect(forbiddenWording(en)).toEqual([]);
  });

  it("the nav keys cover every AppNavId and AdminNavId", () => {
    const appIds: AppNavId[] = [
      "dashboard",
      "cloudServers",
      "databases",
      "objectStorage",
      "loadBalancers",
      "containers",
      "cdn",
      "domains",
      "wallet",
      "invoices",
      "support",
      "settings",
    ];
    const adminIds: AdminNavId[] = [
      "today",
      "customers",
      "payments",
      "pricing",
      "catalog",
      "capacity",
      "operations",
      "support",
      "abuse",
      "reconciliation",
      "audit",
      "admins",
    ];
    for (const tree of [bn, en]) {
      for (const id of appIds) expect(leaf(tree, `Shell.nav.${id}`).length).toBeGreaterThan(0);
      for (const id of adminIds) {
        expect(leaf(tree, `Shell.admin.nav.${id}`).length).toBeGreaterThan(0);
      }
      for (const role of ["superadmin", "ops", "finance", "support"]) {
        expect(leaf(tree, `Shell.admin.roles.${role}`).length).toBeGreaterThan(0);
      }
    }
  });

  it("bn is not a copy of en for Shell.nav.dashboard", () => {
    expect(leaf(bn, "Shell.nav.dashboard")).not.toBe(leaf(en, "Shell.nav.dashboard"));
  });

  it("keeps the footer address and company name unchanged in both locales", () => {
    expect(leaf(bn, "Shell.footer.address")).toBe(leaf(en, "Shell.footer.address"));
    expect(leaf(bn, "Shell.footer.companyName")).toBe("TiCON System Limited");
  });
});
