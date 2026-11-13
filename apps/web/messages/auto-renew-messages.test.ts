import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { autoRenewBn } from "./auto-renew-bn.ts";
import { autoRenewEn } from "./auto-renew-en.ts";

describe("auto-renew switch messages (WPU-Z14)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(autoRenewBn)).toEqual(messageKeys(autoRenewEn));
    for (const tree of [autoRenewBn, autoRenewEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("is composed in both locales, with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(webMessages[locale]["AutoRenew"], locale).toBeDefined();
    }
    expect(JSON.stringify(autoRenewBn.AutoRenew)).toMatch(/[ঀ-৿]/);
  });

  it("every error and result key of the core has a text (U6)", () => {
    for (const tree of [autoRenewBn, autoRenewEn]) {
      const error: Record<string, string> = tree.AutoRenew.error;
      for (const key of [
        "unauthenticated",
        "flag_off",
        "validation",
        "rate_limited",
        "not_found",
        "not_allowed",
        "unavailable",
      ]) {
        expect(error[key], key).toBeDefined();
      }
      expect(Object.keys(tree.AutoRenew.done).sort()).toEqual(["autoRenewOff", "autoRenewOn"]);
    }
  });
});
