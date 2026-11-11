import { forbiddenWording, messageKeys } from "@tc/ui";
import { DETAIL_KEYS } from "@tc/db";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { casesBn } from "./messages/cases.ts";
import { casesEn } from "./messages/cases.en.ts";

describe("AdminCases messages", () => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(casesBn)).toEqual(messageKeys(casesEn));
    for (const tree of [casesBn, casesEn]) {
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim()).not.toBe("");
        else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(tree);
    }
  });

  it("holds every result code the Server Actions can send back", () => {
    expect(Object.keys(casesEn.AdminCases.result).sort()).toEqual(
      [
        "conflict",
        "denied",
        "invalid",
        "not_found",
        "ok",
        "queued",
        "rate_limited",
        "replayed",
        "unavailable",
      ].sort(),
    );
  });

  it("names every detail key the reconciliation projection can send", () => {
    expect(Object.keys(casesEn.AdminCases.reconciliation.detailKey).sort()).toEqual(
      [...DETAIL_KEYS].sort(),
    );
  });

  it("is composed into the app messages for bn and en", () => {
    expect(adminMessages.bn["AdminCases"]).toBeDefined();
    expect(adminMessages.en["AdminCases"]).toBeDefined();
  });

  it("holds no forbidden wording", () => {
    expect(forbiddenWording(casesBn)).toEqual([]);
    expect(forbiddenWording(casesEn)).toEqual([]);
  });

  it("names no AWS account id, ARN or raw error text (16.13)", () => {
    const text = JSON.stringify([casesBn, casesEn]);
    expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AccessDenied|Exception/);
  });
});
