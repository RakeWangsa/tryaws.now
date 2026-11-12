import { describe, expect, it } from "vitest";
import {
  fractionToPercent,
  percentToFraction,
  readBookDraft,
  termsOfDraft,
} from "./price-book-draft.ts";

const getter = (values: Record<string, string>) => (name: string) => values[name] ?? "";

describe("percent text and the fraction of the engine", () => {
  it.each([
    ["15", "0.15"],
    ["12.5", "0.125"],
    ["0", "0"],
    ["0.01", "0.0001"],
    ["100", "1"],
    ["500", "5"],
    ["7.25", "0.0725"],
    ["007", "0.07"],
  ])("%s percent is the fraction %s", (percent, fraction) => {
    expect(percentToFraction(percent)).toBe(fraction);
  });

  it.each(["", "-1", "1e1", "1.234", "abc", "12,5", ".5", "5.", "1000", " 5"])(
    "refuses %j",
    (bad) => {
      expect(percentToFraction(bad)).toBeNull();
    },
  );

  it.each([
    ["0.15", "15"],
    ["0.125", "12.5"],
    ["0", "0"],
    ["0.0001", "0.01"],
    ["1", "100"],
    ["5", "500"],
    ["0.0725", "7.25"],
  ])("the fraction %s is %s percent", (fraction, percent) => {
    expect(fractionToPercent(fraction)).toBe(percent);
  });

  it("a percent survives the round trip", () => {
    for (const p of ["0", "1", "9.9", "12.34", "100", "250.5"]) {
      expect(fractionToPercent(percentToFraction(p) ?? "x")).toBe(p);
    }
  });
});

describe("the draft of a price list entry", () => {
  const full = {
    market: "BD",
    family: "disk",
    marginKind: "percent",
    margin: "15",
    commissionKind: "percent",
    commission: "20",
    from: "2026-12-01T09:00",
  };

  it("reads the fields, trimmed and cut, and falls back on a bad market and family", () => {
    expect(
      readBookDraft(getter({ ...full, market: "x", family: "Bad Family" }), "BD"),
    ).toMatchObject({
      market: "BD",
      family: "",
    });
    expect(readBookDraft(getter({ ...full, margin: "  15  " }), "BD").margin).toBe("15");
    expect(readBookDraft(getter({ ...full, margin: "1".repeat(100) }), "BD").margin).toHaveLength(
      12,
    );
    expect(readBookDraft(getter({}), "BD")).toMatchObject({
      marginKind: "percent",
      commissionKind: "none",
    });
  });

  it("builds the terms of the engine: percent as a fraction, fixed as paisa", () => {
    expect(termsOfDraft(readBookDraft(getter(full), "BD"))).toEqual({
      ok: true,
      terms: {
        margin: { kind: "percent", value: "0.15" },
        commission: { kind: "percent", value: "0.2" },
      },
    });
    expect(
      termsOfDraft(
        readBookDraft(
          getter({ ...full, marginKind: "fixed", margin: "500", commissionKind: "none" }),
          "BD",
        ),
      ),
    ).toEqual({ ok: true, terms: { margin: { kind: "fixed", value: "500" }, commission: null } });
  });

  it("names the fields it refuses", () => {
    expect(termsOfDraft(readBookDraft(getter({ ...full, margin: "abc" }), "BD"))).toEqual({
      ok: false,
      fields: ["margin"],
    });
    expect(
      termsOfDraft(
        readBookDraft(
          getter({ ...full, marginKind: "fixed", margin: "1.5", commission: "1000" }),
          "BD",
        ),
      ),
    ).toEqual({ ok: false, fields: ["margin", "commission"] });
    expect(termsOfDraft(readBookDraft(getter({ ...full, marginKind: "other" }), "BD"))).toEqual({
      ok: false,
      fields: ["marginKind"],
    });
    expect(termsOfDraft(readBookDraft(getter({ ...full, commissionKind: "weird" }), "BD"))).toEqual(
      { ok: false, fields: ["commissionKind"] },
    );
  });
});
