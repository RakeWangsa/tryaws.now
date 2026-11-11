import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { adminsBn } from "./messages/admins.ts";
import { adminsEn } from "./messages/admins.en.ts";
import { auditBn } from "./messages/audit.ts";
import { auditEn } from "./messages/audit.en.ts";
import { adminMessages } from "./i18n/messages.ts";

const PAIRS = [
  ["AdminAudit", auditBn, auditEn],
  ["AdminUsers", adminsBn, adminsEn],
] as const;

describe.each(PAIRS)("%s messages", (name, bn, en) => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(bn)).toEqual(messageKeys(en));
    const walk = (node: unknown): void => {
      if (typeof node === "string") expect(node.trim()).not.toBe("");
      else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    };
    walk(bn);
    walk(en);
  });

  it("is composed into the app messages for bn and en", () => {
    expect(adminMessages.bn[name]).toBeDefined();
    expect(adminMessages.en[name]).toBeDefined();
  });

  it("holds no forbidden wording and no AWS account id, ARN or raw error text (16.13)", () => {
    expect(forbiddenWording(bn)).toEqual([]);
    expect(forbiddenWording(en)).toEqual([]);
    expect(JSON.stringify([bn, en])).not.toMatch(/arn:aws|\b\d{12}\b|AccessDenied|Exception/);
  });
});

it("holds every result code the admins action can send back", () => {
  expect(Object.keys(adminsEn.AdminUsers.result).sort()).toEqual(
    [
      "conflict",
      "denied",
      "directoryFailed",
      "invalid",
      "not_found",
      "ok",
      "rate_limited",
      "replayed",
      "self",
      "unavailable",
    ].sort(),
  );
});
