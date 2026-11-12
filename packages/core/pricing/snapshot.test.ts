import { expect, it } from "vitest";
import { quote } from "./quote";
import {
  SnapshotError,
  parseSnapshot,
  snapshotToQuote,
  toSnapshot,
  type PriceSnapshot,
} from "./snapshot";
import type { PricingRule } from "./types";

const label = { bn: "ক", en: "a" };
const LAUNCH: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};
const PRICED_AT = new Date("2026-11-11T08:00:00.000Z");
const q5 = quote({ awsPriceUsd: "5", fxRate: "127", rule: LAUNCH });
const SNAP5: PriceSnapshot = {
  v: 1,
  currency: "BDT",
  pricedAt: "2026-11-11T08:00:00.000Z",
  awsPriceUsd: "5",
  quantity: "1",
  fxRate: "127",
  ruleVersion: "rule-1",
  baseMinor: "63500",
  steps: [
    { code: "korea_vat", amountMinor: "6350", rate: "0.10" },
    { code: "bd_vat", amountMinor: "3175", rate: "0.05" },
    { code: "processing_fee", amountMinor: "1270", rate: "0.02" },
    { code: "markup", amountMinor: "0", rate: "0" },
  ],
  totalMinor: "74295",
};

it("the snapshot of the 5 USD quote holds the rate, the rule version, every step and the instant, as text", () => {
  expect(toSnapshot(q5, { awsPriceUsd: "5", pricedAt: PRICED_AT })).toEqual(SNAP5);
  expect(toSnapshot(q5, { awsPriceUsd: "5", quantity: "2", pricedAt: PRICED_AT }).quantity).toBe(
    "2",
  );
});

it("a snapshot survives JSON and gives back exactly the quote", () => {
  const stored: unknown = JSON.parse(
    JSON.stringify(toSnapshot(q5, { awsPriceUsd: "5", pricedAt: PRICED_AT })),
  );
  expect(snapshotToQuote(parseSnapshot(stored))).toEqual(q5);
});

it("an amount above 2^53 keeps every digit", () => {
  const big: PriceSnapshot = {
    ...SNAP5,
    baseMinor: "9007199254740993",
    steps: [],
    totalMinor: "9007199254740993",
  };
  expect(parseSnapshot(big)).toEqual(big);
  expect(snapshotToQuote(big).totalMinor).toBe(9007199254740993n);
});

it("parseSnapshot returns a copy: changing it does not change what was given", () => {
  const copy = parseSnapshot(SNAP5);
  copy.steps[0]!.amountMinor = "1";
  expect(SNAP5.steps[0]!.amountMinor).toBe("6350");
});

const without = (key: string) =>
  Object.fromEntries(Object.entries(SNAP5).filter(([k]) => k !== key));
const step = (i: number, over: object) =>
  SNAP5.steps.map((s, n) => (n === i ? { ...s, ...over } : s));
it.each([
  ["a value that is no object", "snapshot", null],
  ["a list", "snapshot", []],
  ["a field of another version", "extra", { ...SNAP5, extra: 1 }],
  ["a missing field", "ruleVersion", without("ruleVersion")],
  ["another version", "v", { ...SNAP5, v: 2 }],
  ["another currency", "currency", { ...SNAP5, currency: "USD" }],
  ["an instant that is not canonical", "pricedAt", { ...SNAP5, pricedAt: "2026-11-11" }],
  ["a price in exponent form", "awsPriceUsd", { ...SNAP5, awsPriceUsd: "5e0" }],
  ["a rate of zero", "fxRate", { ...SNAP5, fxRate: "0" }],
  ["an empty rule version", "ruleVersion", { ...SNAP5, ruleVersion: " " }],
  ["an amount that is a number", "baseMinor", { ...SNAP5, baseMinor: 63500 }],
  ["a negative amount", "baseMinor", { ...SNAP5, baseMinor: "-1" }],
  ["an amount with a leading zero", "baseMinor", { ...SNAP5, baseMinor: "063500" }],
  ["steps that are not a list", "steps", { ...SNAP5, steps: {} }],
  ["a step with a field of its own", "steps[0]", { ...SNAP5, steps: step(0, { note: "x" }) }],
  [
    "a step amount that is a decimal",
    "steps[1].amountMinor",
    { ...SNAP5, steps: step(1, { amountMinor: "3175.5" }) },
  ],
  ["a total that is not the base plus the steps", "totalMinor", { ...SNAP5, totalMinor: "74296" }],
])("refuses %s and names %s", (_, field, json) => {
  let error: unknown;
  try {
    parseSnapshot(json);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(SnapshotError);
  expect(error).toBeInstanceOf(RangeError);
  expect((error as SnapshotError).field).toBe(field);
});

it("toSnapshot refuses an invalid instant and a price that is not plain decimal text", () => {
  expect(() => toSnapshot(q5, { awsPriceUsd: "5", pricedAt: new Date("nope") })).toThrow(
    SnapshotError,
  );
  expect(() => toSnapshot(q5, { awsPriceUsd: "$5", pricedAt: PRICED_AT })).toThrow(/awsPriceUsd/);
});

it("snapshotToQuote checks a snapshot that was forged in memory", () => {
  expect(() => snapshotToQuote({ ...SNAP5, totalMinor: "1" })).toThrow(SnapshotError);
});

// WPU-I2: the rate of a step is stored with it; a snapshot stored before has none and still parses.
it("WPU-I2: a step rate is optional, plain decimal text, and survives the round trip", () => {
  const old: PriceSnapshot = {
    ...SNAP5,
    steps: SNAP5.steps.map(({ code, amountMinor }) => ({ code, amountMinor })),
  };
  expect(parseSnapshot(old)).toEqual(old);
  expect(parseSnapshot(SNAP5).steps[1]).toEqual({
    code: "bd_vat",
    amountMinor: "3175",
    rate: "0.05",
  });
  for (const bad of ["5%", "-0.05", "0,05", "", 0.05, null]) {
    expect(() => parseSnapshot({ ...SNAP5, steps: step(1, { rate: bad }) })).toThrow(SnapshotError);
  }
  expect(snapshotToQuote(parseSnapshot(SNAP5)).steps[1]).toEqual({
    code: "bd_vat",
    amountMinor: 3175n,
    rate: "0.05",
  });
});
