import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { accountBn } from "./account-bn.ts";
import { accountEn } from "./account-en.ts";

describe("messages of the Snapshots, Static IPs and Billing pages (WPU-G5)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(accountBn)).toEqual(messageKeys(accountEn));
    expect(messageKeys(accountBn).length).toBeGreaterThan(80);
    for (const tree of [accountBn, accountEn]) {
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
      for (const space of ["AccountNav", "Snapshots", "StaticIps", "Billing"]) {
        expect(webMessages[locale][space], `${locale} ${space}`).toBeDefined();
      }
    }
    expect((webMessages.bn["Billing"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });

  it("keeps the same placeholders in bn and en", () => {
    const holes = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
    const get = (tree: unknown, key: string): string =>
      key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree) as string;
    for (const key of messageKeys(accountBn)) {
      expect(holes(get(accountBn, key)), key).toEqual(holes(get(accountEn, key)));
    }
  });

  it("shows no account id or ARN, and names AWS only as Amazon Lightsail (U6, 16.13)", () => {
    for (const tree of [accountBn, accountEn]) {
      expect(JSON.stringify(tree)).not.toMatch(/arn:aws|\b\d{12}\b|AWS Lightsail/);
    }
  });
});
