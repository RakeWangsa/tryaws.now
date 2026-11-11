import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { moneyBn } from "./messages/money.ts";
import { moneyEn } from "./messages/money.en.ts";

describe("AdminMoney messages", () => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(moneyBn)).toEqual(messageKeys(moneyEn));
    for (const tree of [moneyBn, moneyEn]) {
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim()).not.toBe("");
        else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(tree);
    }
  });

  it("holds every result code the Server Action can send back", () => {
    expect(Object.keys(moneyEn.AdminMoney.result).sort()).toEqual(
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

  it("holds every state of a payment and every kind of ledger line", () => {
    expect(Object.keys(moneyEn.AdminMoney.payments.status).sort()).toEqual(
      [
        "pending",
        "initiated",
        "redirected",
        "credited",
        "failed",
        "cancelled",
        "expired",
        "review",
      ].sort(),
    );
    expect(Object.keys(moneyEn.AdminMoney.wallet.kinds).sort()).toEqual(
      ["topup", "purchase", "renewal", "metered_charge", "reversal", "adjustment", "refund"].sort(),
    );
  });

  it("is composed into the app messages for bn and en", () => {
    expect(adminMessages.bn["AdminMoney"]).toBeDefined();
    expect(adminMessages.en["AdminMoney"]).toBeDefined();
  });

  it("holds no forbidden wording", () => {
    expect(forbiddenWording(moneyBn)).toEqual([]);
    expect(forbiddenWording(moneyEn)).toEqual([]);
  });

  it("names no AWS account id, ARN or raw error text (16.13)", () => {
    const text = JSON.stringify([moneyBn, moneyEn]);
    expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AccessDenied|Exception/);
  });
});
