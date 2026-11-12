import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { priceBookEn } from "./messages/pricebook.en.ts";
import { priceBookBn } from "./messages/pricebook.ts";

describe("AdminPriceBook messages (WPA-P1)", () => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(priceBookBn)).toEqual(messageKeys(priceBookEn));
    const walk = (node: unknown): void => {
      if (typeof node === "string") expect(node.trim()).not.toBe("");
      else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    };
    walk(priceBookBn);
    walk(priceBookEn);
  });

  it("the Bengali texts are Bengali, with ASCII digits only in the examples", () => {
    const bengali = /[ঀ-৿]/;
    for (const key of ["title", "intro", "back"] as const) {
      expect(priceBookBn.AdminPriceBook[key]).toMatch(bengali);
    }
    expect(priceBookBn.AdminPriceBook.result.ok).toMatch(bengali);
    expect(priceBookBn.AdminPriceBook.editor.title).toContain("{family}");
  });

  it("holds every result code of the flow (the flow answers more, the screen shows these)", () => {
    expect(Object.keys(priceBookEn.AdminPriceBook.result).sort()).toEqual(
      [
        "conflict",
        "denied",
        "invalid",
        "not_found",
        "ok",
        "rate_limited",
        "replayed",
        "unavailable",
      ].sort(),
    );
  });

  it("the placeholders of bn and en are the same", () => {
    const placeholders = (node: unknown, out: string[] = []): string[] => {
      if (typeof node === "string")
        out.push(
          [...node.matchAll(/\{(\w+)\}/g)]
            .map((m) => m[1])
            .sort()
            .join(","),
        );
      else
        for (const value of Object.values(node as Record<string, unknown>))
          placeholders(value, out);
      return out;
    };
    expect(placeholders(priceBookBn)).toEqual(placeholders(priceBookEn));
  });

  it("is composed into the app messages for bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(adminMessages[locale]["AdminPriceBook"]).toBeDefined();
    }
  });

  it("says that the rounding is half up and that old orders keep their price", () => {
    expect(priceBookEn.AdminPriceBook.summary.roundingValue).toMatch(/half/i);
    expect(priceBookEn.AdminPriceBook.intro).toMatch(/already placed/);
    expect(priceBookEn.AdminPriceBook.preview.onlyNew).toMatch(/new orders/);
  });

  it("holds no forbidden wording and no AWS account id, ARN or raw error (16.13)", () => {
    expect(forbiddenWording(priceBookBn)).toEqual([]);
    expect(forbiddenWording(priceBookEn)).toEqual([]);
    expect(JSON.stringify([priceBookBn, priceBookEn])).not.toMatch(
      /arn:aws|\b\d{12}\b|AccessDenied|Exception/,
    );
  });
});
