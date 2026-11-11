import { LAUNCH_PRICING_STEPS, seedLaunchData } from "@tc/db";
import { ensureMarket, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { PREVIEW_SAMPLES, type PricingStep } from "../pricing/index";
import { previewChange } from "./index";
import { asOwner, asRole, clockAt } from "../test/rates-support";

const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";
const steps = (markup: string): PricingStep[] =>
  LAUNCH_PRICING_STEPS.map((s) => ({
    ...s,
    label: { ...s.label },
    rate: s.code === "markup" ? markup : s.rate,
  }));
const preview = (input: Record<string, unknown>, market = "BD") =>
  asRole(t, "admin_rw", (tx) =>
    previewChange(tx, { market, productFamily: "linux_instance", ...input }, clockAt(T0)),
  );

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
  await ensureMarket(t.pool, "KE");
});

it("a new rate: the five samples at the new rate next to the five at the rate in force", async () => {
  const r = await preview({ fxRate: "130" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.rows.map((row) => row.sampleId)).toEqual(PREVIEW_SAMPLES.map((s) => s.id));
  const first = r.value.rows[0]!;
  expect([first.candidate.totalMinor, first.current!.totalMinor, first.deltaMinor]).toEqual([
    76050n,
    74295n,
    1755n,
  ]);
  expect(first.candidate.ruleVersion).toBe("preview");
  expect([first.current!.fxRate, first.candidate.fxRate]).toEqual(["127", "130"]);
});

it("a new rule: the five samples under the new steps at the rate in force", async () => {
  const r = await preview({ steps: steps("0.03") });
  expect(r.ok && [r.value.rows[0]!.candidate.totalMinor, r.value.rows[0]!.deltaMinor]).toEqual([
    76200n,
    1905n,
  ]);
});

it("nothing given: the candidate is what is in force, so no total changes", async () => {
  const r = await preview({});
  expect(r.ok && r.value.rows.map((row) => row.deltaMinor)).toEqual([0n, 0n, 0n, 0n, 0n]);
});

it("a rate that numeric(12,6) would round, and a rule the engine refuses, are validation failures", async () => {
  expect(await preview({ fxRate: "127.1234567" })).toEqual({
    ok: false,
    error: "validation",
    fields: { fxRate: "invalid" },
  });
  const negative = steps("0");
  negative[1] = { ...negative[1]!, base: "subtotal" };
  expect(await preview({ steps: negative })).toEqual({
    ok: false,
    error: "validation",
    fields: { "steps[1].base": "step bd_vat has base subtotal and is not the last step" },
  });
});

it("a bad market or family is a validation failure", async () => {
  expect(await preview({}, "bd")).toMatchObject({
    ok: false,
    error: "validation",
    fields: { market: "invalid" },
  });
  expect(await preview({ productFamily: "toaster" })).toMatchObject({
    ok: false,
    fields: { productFamily: "unknown" },
  });
});

it("a market with nothing in force can be previewed when both the rate and the steps are given, without a current", async () => {
  const r = await preview({ fxRate: "1.25", steps: steps("0") }, "KE");
  expect(r.ok && r.value.rows.every((row) => row.current === null && row.deltaMinor === null)).toBe(
    true,
  );
  expect(await preview({ fxRate: "1.25" }, "KE")).toEqual({
    ok: false,
    error: "validation",
    fields: { steps: "not_in_force" },
  });
  expect(await preview({ steps: steps("0") }, "KE")).toEqual({
    ok: false,
    error: "validation",
    fields: { fxRate: "not_in_force" },
  });
});
