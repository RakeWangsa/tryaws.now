import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { databasesBn } from "./databases-bn.ts";
import { databasesEn } from "./databases-en.ts";

describe("database screen messages (WP6-T2)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(databasesBn)).toEqual(messageKeys(databasesEn));
    expect(messageKeys(databasesBn).length).toBeGreaterThan(100);
    for (const tree of [databasesBn, databasesEn]) {
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
      expect(webMessages[locale]["Databases"], locale).toBeDefined();
    }
    expect((webMessages.bn["Databases"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });

  it("names Amazon Lightsail the exact way and shows no account id or ARN (U6, 16.13)", () => {
    for (const tree of [databasesBn, databasesEn]) {
      const text = JSON.stringify(tree);
      expect(text).toContain("Amazon Lightsail managed database");
      expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AWS Lightsail/);
    }
  });

  it("tells the password rules of U9: once, 60 seconds, not kept", () => {
    expect(databasesEn.Databases.detail.access.warning).toMatch(/once.*60 seconds.*not kept/);
    expect(databasesBn.Databases.detail.access.warning).toContain("৬০ সেকেন্ড");
  });

  it("every action error key of the cores has a text (U6)", () => {
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
      expect(databasesEn.Databases.error, key).toHaveProperty(key);
    }
    for (const key of ["started", "stopped", "destroyQueued", "approval"]) {
      expect(databasesEn.Databases.done, key).toHaveProperty(key);
    }
  });
});
