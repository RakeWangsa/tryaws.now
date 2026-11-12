import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { planChangeEn } from "./messages/planchange.en.ts";
import { planChangeBn } from "./messages/planchange.ts";

describe("AdminPlanChange messages (WPA-P2)", () => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(planChangeBn)).toEqual(messageKeys(planChangeEn));
    for (const tree of [planChangeBn, planChangeEn]) {
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim()).not.toBe("");
        else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(tree);
    }
  });

  it("holds every result code of the action and every resource state", () => {
    expect(Object.keys(planChangeEn.AdminPlanChange.result).sort()).toEqual(
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
    expect(Object.keys(planChangeEn.AdminPlanChange.states).sort()).toEqual(
      ["active", "creating", "destroyed", "failed", "stopped", "suspended"].sort(),
    );
  });

  it("is composed into the app messages for bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(adminMessages[locale]["AdminPlanChange"]).toBeDefined();
    }
  });

  it("holds no forbidden wording", () => {
    expect(forbiddenWording(planChangeBn)).toEqual([]);
    expect(forbiddenWording(planChangeEn)).toEqual([]);
  });
});
