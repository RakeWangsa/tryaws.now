import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as kit from "../index";
import { kitMessages, loadKitMessages, mergeKit } from "../messages/index";
import type { Locale } from "./types";

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const uiRoot = resolve(here, "..");
const indexSource = readFileSync(join(uiRoot, "index.ts"), "utf8");
const messagesSource = readFileSync(join(uiRoot, "messages", "index.ts"), "utf8");

const componentModules = readdirSync(here)
  .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
  .map((file) => file.slice(0, -".tsx".length))
  .filter((name) => name !== "EmptyIllustration")
  .sort();

// The list lives in source-rules.test.ts, which is a test file with describe blocks: read it as text.
const clientComponents = (): string[] => {
  const source = readFileSync(join(here, "source-rules.test.ts"), "utf8");
  const body = /CLIENT_COMPONENTS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
  return [...body.matchAll(/"(\w+)"/g)].map((m) => m[1] as string);
};

describe("barrel packages/ui/index.ts", () => {
  it("re-exports every components/*.tsx module except the internal EmptyIllustration", () => {
    const reExported = [
      ...indexSource.matchAll(/export \* from "\.\/components\/(\w+)(?:\.tsx)?"/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(reExported).toEqual(componentModules);
    expect(indexSource).not.toMatch(/EmptyIllustration/);
  });

  it("keeps the shells line and has no use client directive", () => {
    expect(indexSource).toMatch(/export \* from "\.\/shells\/index(?:\.ts)?"/);
    expect(indexSource).not.toMatch(/use client/);
  });

  it("exports the components, helpers and format functions", () => {
    for (const name of [
      "Button",
      "MoneyText",
      "Tabs",
      "Badge",
      "StateBadge",
      "Card",
      "Field",
      "FormBlock",
      "fieldIds",
      "ToastProvider",
      "useToast",
      "formatMoney",
      "formatDate",
      "toLocale",
    ]) {
      expect(typeof (kit as Record<string, unknown>)[name], name).toBe("function");
    }
    expect((kit as Record<string, unknown>)["EmptyIllustration"]).toBeUndefined();
  });

  it("every client component of the list exists on disk", () => {
    const names = clientComponents();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(componentModules, name).toContain(name);
  });
});

describe("messages/index.ts", () => {
  it("imports every JSON file of bn and en", () => {
    for (const locale of ["bn", "en"]) {
      const files = readdirSync(join(uiRoot, "messages", locale)).filter((f) =>
        f.endsWith(".json"),
      );
      const imported = [
        ...messagesSource.matchAll(new RegExp(`"\\./${locale}/([\\w-]+\\.json)"`, "g")),
      ].map((m) => m[1]);
      expect(imported.sort(), locale).toEqual(files.sort());
    }
  });

  it("builds the Bengali and English kit messages", () => {
    expect(kitMessages.bn.kit["common"]?.["close"]).toBe("বন্ধ করুন");
    expect(kitMessages.en.kit["common"]?.["close"]).toBe("Close");
    expect(Object.keys(kitMessages.bn.kit).sort()).toEqual(Object.keys(kitMessages.en.kit).sort());
  });

  it("mergeKit keeps both groups", () => {
    const merged = mergeKit([{ kit: { a: { x: "1" } } }, { kit: { b: { y: "2" } } }]);
    expect(merged).toEqual({ kit: { a: { x: "1" }, b: { y: "2" } } });
  });

  it("loadKitMessages returns the locale and refuses an unknown one", () => {
    expect(loadKitMessages("bn")).toBe(kitMessages.bn);
    expect(() => loadKitMessages("fr" as Locale)).toThrow();
  });
});
