import { forbiddenWording, messageKeys } from "@tc/ui";
import { OPERATION_KINDS, OPERATION_STATES, QUOTA_CODES } from "@tc/db";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { ERROR_CODES } from "./server/ops-map.ts";
import { opsBn } from "./messages/ops.ts";
import { opsEn } from "./messages/ops.en.ts";

describe("AdminOps and AdminCapacity messages", () => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(opsBn)).toEqual(messageKeys(opsEn));
    for (const tree of [opsBn, opsEn]) {
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim()).not.toBe("");
        else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(tree);
    }
  });

  it("holds a line for every state, kind, error code and quota the screens can meet", () => {
    expect(Object.keys(opsEn.AdminOps.state).sort()).toEqual([...OPERATION_STATES].sort());
    expect(Object.keys(opsEn.AdminOps.kind).sort()).toEqual([...OPERATION_KINDS, "other"].sort());
    expect(Object.keys(opsEn.AdminOps.errors).sort()).toEqual(
      [...ERROR_CODES, "other", "none"].sort(),
    );
    expect(Object.keys(opsEn.AdminCapacity.quota).sort()).toEqual([...QUOTA_CODES].sort());
  });

  it("holds every result code of both Server Actions", () => {
    const codes = [
      "conflict",
      "denied",
      "invalid",
      "not_found",
      "ok",
      "rate_limited",
      "replayed",
      "unavailable",
    ];
    expect(Object.keys(opsEn.AdminOps.result).sort()).toEqual(codes);
    expect(Object.keys(opsEn.AdminCapacity.result).sort()).toEqual(codes);
  });

  it("is composed into the app messages for bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(adminMessages[locale]["AdminOps"]).toBeDefined();
      expect(adminMessages[locale]["AdminCapacity"]).toBeDefined();
    }
  });

  it("holds no forbidden wording", () => {
    expect(forbiddenWording(opsBn)).toEqual([]);
    expect(forbiddenWording(opsEn)).toEqual([]);
  });
});
