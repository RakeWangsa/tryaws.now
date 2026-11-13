import { LAUNCH_PRICING_STEPS, STEP_CODES, type AdminActor } from "@tc/db";
import { auditRowsOf, ensureMarket, insertRow, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { STEP_ACCOUNTS, type PricingStep } from "../pricing/index";
import { adminActor } from "../test/admin-support";
import { asRole, clockAt } from "../test/rates-support";
import { quoteInForce, savePricingRule, type SavePricingRuleInput } from "./index";

const t = useTempDatabase();
const T0 = new Date("2026-11-11T06:00:00.000Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const steps = (markup = "0"): PricingStep[] =>
  LAUNCH_PRICING_STEPS.map((s) => ({
    ...s,
    label: { ...s.label },
    rate: s.code === "markup" ? markup : s.rate,
  }));

let actor: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  actor = await adminActor(t, "finance");
  await insertRow(t.pool, "fx_rates", {
    market: "BD",
    rate: "127",
    effective_from: "2026-11-01T00:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
  });
});
const save = (input: Partial<SavePricingRuleInput>, now: Date = T0) =>
  asRole(t, "admin_rw", (tx) =>
    savePricingRule(
      tx,
      actor,
      { market: "BD", productFamily: null, steps: steps(), reason: "rule change", ...input },
      { now: () => now },
    ),
  );
const count = async () =>
  (await t.pool.query("select count(*)::int as n from pricing_rules")).rows[0].n as number;
const audits = () => auditRowsOf(t.pool, actor.adminId);

it("the first rule is saved, its row id is its version, and a quote uses it", async () => {
  const r = await save({ reason: "launch rule" });
  expect(r).toEqual({
    ok: true,
    value: { ruleId: expect.any(String), productFamily: null, effectiveFrom: T0, replayed: false },
  });
  const ruleId = r.ok ? r.value.ruleId : "";
  const priced = await asRole(t, "web_rw", (tx) =>
    quoteInForce(
      tx,
      { market: "BD", productFamily: "linux_instance", awsPriceUsd: "5" },
      clockAt(T0.toISOString()),
    ),
  );
  expect(priced.ok && [priced.value.quote.ruleVersion, priced.value.quote.totalMinor]).toEqual([
    ruleId,
    74295n,
  ]);
  expect(await audits()).toMatchObject([
    {
      action: "pricing_rule.save",
      target_type: "pricing_rule",
      target_id: "BD/*@2026-11-11T06:00:00.000Z",
      metadata: { reason: "launch rule", before: null },
    },
  ]);
});

it("a rule the engine refuses never reaches the table: subtotal not last, a code without an account, a repeated code", async () => {
  const n = await count();
  const a = (await audits()).length;
  const negative = steps();
  negative[1] = { ...negative[1]!, base: "subtotal" };
  expect(await save({ steps: negative }, hours(1))).toEqual({
    ok: false,
    error: "validation",
    fields: { "steps[1].base": "step bd_vat has base subtotal and is not the last step" },
  });
  const handling: PricingStep = {
    code: "handling",
    rate: "0.01",
    base: "aws",
    label: { bn: "ক", en: "a" },
  };
  expect(await save({ steps: [handling] }, hours(1))).toMatchObject({
    ok: false,
    fields: { "steps[0].code": "step handling has no ledger account" },
  });
  expect(await save({ steps: [...steps(), steps()[3]!] }, hours(1))).toMatchObject({
    ok: false,
    fields: { "steps[4].code": "step markup appears twice" },
  });
  expect(await save({ steps: "none" as unknown as PricingStep[] }, hours(1))).toMatchObject({
    ok: false,
    fields: { steps: "steps is not a list" },
  });
  expect(await count()).toBe(n);
  expect((await audits()).length).toBe(a);
});

it("the alternative rule (VAT last, on the subtotal) is accepted", async () => {
  const alt = steps();
  const bd = alt.splice(1, 1)[0]!;
  alt.push({ ...bd, base: "subtotal" });
  expect(
    await save(
      { steps: alt, productFamily: "windows_instance", effectiveFrom: hours(2) },
      hours(2),
    ),
  ).toMatchObject({
    ok: true,
    value: { productFamily: "windows_instance", replayed: false },
  });
});

it("steps are stored in the plain form: a field the engine does not know is dropped", async () => {
  const noisy = steps("0.03").map((s) => ({ ...s, note: "ignored" }));
  expect(
    (
      await save(
        { steps: noisy, productFamily: "linux_instance", effectiveFrom: hours(3) },
        hours(3),
      )
    ).ok,
  ).toBe(true);
  const { rows } = await t.pool.query(
    "select steps from pricing_rules where product_family = 'linux_instance'",
  );
  expect(rows[0].steps).toEqual(steps("0.03"));
});

it("the same start with the same steps is a replay; with other steps it is a conflict; the steps in force, to start now, add no row", async () => {
  const start = hours(30);
  expect(await save({ steps: steps("0.04"), effectiveFrom: start }, hours(4))).toMatchObject({
    ok: true,
    value: { replayed: false },
  });
  const n = await count();
  expect(await save({ steps: steps("0.04"), effectiveFrom: start }, hours(5))).toMatchObject({
    ok: true,
    value: { replayed: true, effectiveFrom: start },
  });
  expect(await save({ steps: steps("0.05"), effectiveFrom: start }, hours(5))).toEqual({
    ok: false,
    error: "conflict",
    fields: { effectiveFrom: "taken_by_other_steps" },
  });
  // the steps in force, to start now: the rule of T0 has these steps, so no row is added
  expect(await save({}, hours(6))).toMatchObject({
    ok: true,
    value: { replayed: true, effectiveFrom: T0 },
  });
  expect(await count()).toBe(n);
});

it.each([
  [
    "a family that is no product family",
    { productFamily: "toaster" },
    { productFamily: "unknown" },
  ],
  ["a market in lower case", { market: "bd" }, { market: "invalid" }],
  ["a market that does not exist", { market: "KE" }, { market: "unknown" }],
  ["a blank reason", { reason: " " }, { reason: "required" }],
  [
    "a start in the past",
    { effectiveFrom: new Date(hours(5).getTime() - 1) },
    { effectiveFrom: "in_the_past" },
  ],
  [
    "a start 91 days ahead",
    { effectiveFrom: new Date(hours(5).getTime() + 91 * 86_400_000) },
    { effectiveFrom: "too_far_ahead" },
  ],
])("%s is a validation failure that names the field", async (_, over, fields) => {
  const n = await count();
  expect(await save({ steps: steps("0.01"), ...over }, hours(5))).toEqual({
    ok: false,
    error: "validation",
    fields,
  });
  expect(await count()).toBe(n);
});

it("web_rw cannot save a rule: the database refuses with 42501", async () => {
  await expect(
    asRole(t, "web_rw", (tx) =>
      savePricingRule(
        tx,
        actor,
        { market: "BD", productFamily: null, steps: steps("0.02"), reason: "x" },
        clockAt("2026-12-01T00:00:00Z"),
      ),
    ),
  ).rejects.toMatchObject({ name: "DbError", code: "42501" });
});

it("the step codes that @tc/db copies are the codes that have a ledger account in the engine", () => {
  expect([...STEP_CODES].sort()).toEqual(Object.keys(STEP_ACCOUNTS).sort());
});
