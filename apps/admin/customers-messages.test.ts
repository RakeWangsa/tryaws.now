import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { customersBn } from "./messages/customers.ts";
import { customersEn } from "./messages/customers.en.ts";

describe("AdminCustomers messages", () => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(customersBn)).toEqual(messageKeys(customersEn));
    for (const tree of [customersBn, customersEn]) {
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim()).not.toBe("");
        else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(tree);
    }
  });

  it("holds every result code the Server Action can send back", () => {
    const codes = Object.keys(customersEn.AdminCustomers.result).sort();
    expect(codes).toEqual(
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

  it("is composed into the app messages for bn and en", () => {
    expect(adminMessages.bn["AdminCustomers"]).toBeDefined();
    expect(adminMessages.en["AdminCustomers"]).toBeDefined();
  });

  it("holds no forbidden wording", () => {
    expect(forbiddenWording(customersBn)).toEqual([]);
    expect(forbiddenWording(customersEn)).toEqual([]);
  });

  it("names no AWS account id, ARN or raw error text (16.13)", () => {
    const text = JSON.stringify([customersBn, customersEn]);
    expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AccessDenied|Exception/);
  });
});
