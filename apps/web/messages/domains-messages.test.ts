import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { domainsBn } from "./domains-bn.ts";
import { domainsEn } from "./domains-en.ts";

describe("domain screen messages (WP7-T4)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(domainsBn)).toEqual(messageKeys(domainsEn));
    expect(messageKeys(domainsBn).length).toBeGreaterThan(80);
    for (const tree of [domainsBn, domainsEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("is composed in both locales in its own namespace, with bn text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(webMessages[locale]["Domains"], locale).toBeDefined();
    }
    expect((webMessages.bn["Domains"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });

  it("names Amazon Route 53 and shows no account id, ARN or ICANN logo text (U6, 16.13, spec 12)", () => {
    for (const tree of [domainsBn, domainsEn]) {
      const text = JSON.stringify(tree);
      expect(text).toContain("Amazon Route 53");
      expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AWS Route 53/);
    }
  });
});
