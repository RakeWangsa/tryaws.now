import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { consoleBn } from "./console-bn.ts";
import { consoleEn } from "./console-en.ts";

describe("console form messages (WPU-G7)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(consoleBn)).toEqual(messageKeys(consoleEn));
    for (const tree of [consoleBn, consoleEn]) {
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
      expect(webMessages[locale]["Console"], locale).toBeDefined();
    }
    expect(JSON.stringify(consoleBn.Console.db)).toMatch(/[ঀ-৿]/);
  });

  it("shows no account id or ARN (U6)", () => {
    for (const tree of [consoleBn, consoleEn]) {
      expect(JSON.stringify(tree)).not.toMatch(/arn:aws|\b\d{12}\b/);
    }
  });

  it("every error key of the cores has a text, and every result key too (U6)", () => {
    for (const key of [
      "unauthenticated",
      "fresh_sign_in_required",
      "flag_off",
      "validation",
      "rate_limited",
      "not_found",
      "name_mismatch",
      "not_allowed",
      "unavailable",
    ]) {
      expect(consoleEn.Console.error).toHaveProperty(key);
    }
    for (const key of [
      "settingsQueued",
      "certificateQueued",
      "certificateRefreshQueued",
      "optionsQueued",
      "versioningQueued",
      "cacheResetQueued",
    ]) {
      expect(consoleEn.Console.done).toHaveProperty(key);
    }
  });
});
