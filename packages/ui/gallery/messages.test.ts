import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadKitMessages } from "../messages/index.ts";
import { composeMessages, type Messages } from "../runtime/index.ts";
import { forbiddenWording, messageKeys, missingKeys } from "../shells/message-checks.ts";
import { shellMessages } from "../shells/messages/index.ts";
import { galleryMessages } from "./messages/index.ts";

const { bn, en } = galleryMessages;

function leaf(tree: Messages, dotted: string): unknown {
  let node: string | Messages = tree;
  for (const part of dotted.split(".")) node = (node as Messages)[part] as string | Messages;
  return node;
}

describe("galleryMessages", () => {
  it("bn and en have the same keys", () => {
    expect(missingKeys(bn, en)).toEqual([]);
    expect(missingKeys(en, bn)).toEqual([]);
    expect(messageKeys(bn).length).toBeGreaterThan(100);
  });

  it("every leaf is a non-empty string", () => {
    for (const [locale, tree] of Object.entries(galleryMessages)) {
      for (const key of messageKeys(tree)) {
        const value = leaf(tree, key);
        expect(typeof value, `${locale} ${key}`).toBe("string");
        expect((value as string).trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("holds no forbidden wording (16.13, R11, R14)", () => {
    expect(forbiddenWording(bn)).toEqual([]);
    expect(forbiddenWording(en)).toEqual([]);
  });

  it("owns only the top-level key Gallery, so it cannot collide with Shell, Aws, Web, Admin or kit", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(Object.keys(galleryMessages[locale]), locale).toEqual(["Gallery"]);
      expect(() =>
        composeMessages(
          loadKitMessages(locale) as Messages,
          shellMessages[locale],
          { Web: { x: "x" } },
          { Admin: { x: "x" } },
          galleryMessages[locale],
        ),
      ).not.toThrow();
    }
  });

  it("every sample has a title and a mockup source; a named mockup page reads the same in both locales", () => {
    const keys = messageKeys(bn);
    const titles = keys.filter(
      (key) => key.startsWith("Gallery.samples.") && key.endsWith(".title"),
    );
    expect(titles.length).toBeGreaterThanOrEqual(30);
    for (const title of titles) {
      const source = title.replace(/\.title$/, ".source");
      expect(keys, source).toContain(source);
      // A source that names a mockup page is an identifier, not prose: it is the same text.
      if (String(leaf(bn, source)).includes(".html")) {
        expect(leaf(bn, source), source).toBe(leaf(en, source));
      }
    }
  });

  it("writes bn before en in the module (U5)", () => {
    const source = readFileSync(new URL("./messages/index.ts", import.meta.url), "utf8");
    expect(source.indexOf("bn")).toBeLessThan(source.indexOf("en"));
    const bnFile = readFileSync(new URL("./messages/bn.ts", import.meta.url), "utf8");
    expect(bnFile).toMatch(/Bengali is written first/);
  });
});
