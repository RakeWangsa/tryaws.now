import { FEATURE_FLAGS } from "@tc/core";
import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { pricingEn } from "./messages/pricing.en.ts";
import { pricingBn } from "./messages/pricing.ts";
import { dependenciesOf } from "./server/flag-dependencies.ts";
import { PRICING_ROLES } from "./server/pricing-flow.ts";
import {
  MAX_DRAFT_STEPS,
  fieldName,
  readDraft,
  startOf,
  wantsPreview,
} from "./server/pricing-draft.ts";

describe("AdminPricing and AdminCatalog messages", () => {
  it("bn and en have the same keys and no empty text", () => {
    expect(messageKeys(pricingBn)).toEqual(messageKeys(pricingEn));
    const walk = (node: unknown): void => {
      if (typeof node === "string") expect(node.trim()).not.toBe("");
      else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    };
    walk(pricingBn);
    walk(pricingEn);
  });

  it("holds every result code the flow can answer", () => {
    const codes = [
      "ok",
      "replayed",
      "pending",
      "approved",
      // WPU-X9: a rate set by one admin alone (owner decision 2026-11-14).
      "set",
      "invalid",
      "denied",
      "conflict",
      "not_found",
      "rate_limited",
      "unavailable",
      "second_admin_required",
      "must_differ_from_actor",
      "not_an_approver",
      "confirm_required",
    ];
    expect(Object.keys(pricingEn.AdminPricing.result).sort()).toEqual([...codes].sort());
    for (const code of codes.filter(
      (c) =>
        ![
          "pending",
          "approved",
          "set",
          "second_admin_required",
          "must_differ_from_actor",
          "not_an_approver",
          "confirm_required",
        ].includes(c),
    )) {
      expect(Object.keys(pricingEn.AdminCatalog.result)).toContain(code);
    }
  });

  it("WPU-X9: the FX form says that up to the single-admin percent applies at once and more waits", () => {
    const en = pricingEn.AdminPricing.fx.bigChange;
    expect(en).toContain("up to {single}% within {hours} hours");
    expect(en).toContain("apply at once");
    expect(en).toContain("waits until a different admin approves it");
    expect(en).toContain("scheduled");
    expect(pricingEn.AdminPricing.result.set).toContain("3% within 24 hours");
  });

  it("names every product family", () => {
    expect(Object.keys(pricingEn.AdminCatalog.flags.names).sort()).toEqual(
      [...FEATURE_FLAGS].sort(),
    );
  });

  it("names the five preview samples", () => {
    expect(Object.keys(pricingEn.AdminPricing.preview.samples).sort()).toEqual(
      ["backup_1gb_day", "disk_80gb", "instance_24", "instance_5", "instance_84"].sort(),
    );
  });

  it("is composed into the app messages for bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(adminMessages[locale]["AdminPricing"]).toBeDefined();
      expect(adminMessages[locale]["AdminCatalog"]).toBeDefined();
    }
  });

  it("holds no forbidden wording and no AWS account id, ARN or raw error (16.13)", () => {
    expect(forbiddenWording(pricingBn)).toEqual([]);
    expect(forbiddenWording(pricingEn)).toEqual([]);
    expect(JSON.stringify([pricingBn, pricingEn])).not.toMatch(
      /arn:aws|\b\d{12}\b|AccessDenied|Exception/,
    );
  });
});

describe("the dependencies of a family", () => {
  it("only name families that are flags, and no family needs itself", () => {
    for (const key of FEATURE_FLAGS) {
      for (const dep of dependenciesOf(key)) {
        expect(FEATURE_FLAGS).toContain(dep);
        expect(dep).not.toBe(key);
      }
    }
    expect(dependenciesOf("toString")).toEqual([]);
  });
});

describe("the draft of the editor", () => {
  const query = (o: Record<string, string>) => (name: string) => o[name] ?? "";

  it("drops blank rows, trims, and falls back to the default market", () => {
    const draft = readDraft(
      query({
        market: "xx",
        code0: " markup ",
        rate0: "0.15",
        base0: "subtotal",
        family: "backup",
      }),
      "BD",
    );
    expect(draft).toEqual({
      market: "BD",
      family: "backup",
      steps: [{ code: "markup", rate: "0.15", base: "subtotal", bn: "", en: "" }],
      from: "",
      fx: "",
    });
  });

  it("reads at most the rows of the editor and treats a bad family as the whole market", () => {
    const many: Record<string, string> = { family: "Not A Key" };
    for (let i = 0; i < MAX_DRAFT_STEPS + 3; i += 1) many[fieldName("code", i)] = "markup";
    const draft = readDraft(query(many), "BD");
    expect(draft.steps).toHaveLength(MAX_DRAFT_STEPS);
    expect(draft.family).toBeNull();
  });

  it("a preview is asked for with go=1 only", () => {
    expect(wantsPreview(query({ go: "1" }))).toBe(true);
    expect(wantsPreview(query({ go: "yes" }))).toBe(false);
    expect(wantsPreview(query({}))).toBe(false);
  });

  it("reads a start as Dhaka time (UTC+6), empty as now and anything else as invalid", () => {
    expect(startOf("")).toBeUndefined();
    expect(startOf("2026-11-20T09:30")?.toISOString()).toBe("2026-11-20T03:30:00.000Z");
    expect(startOf("2026-13-45T99:99")).toBeNull();
    expect(startOf("tomorrow")).toBeNull();
  });
});

describe("who may open and act", () => {
  it("the pricing roles are the two of 16.12", () => {
    expect([...PRICING_ROLES].sort()).toEqual(["finance", "superadmin"]);
  });
});
