import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import type { PricingStepInput } from "../repositories/admin/pricing-rules";
import { readPricingRuleInForce } from "../repositories/config/pricing-rules";
import { auditRowsOf } from "../testing/repos";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const UUID7 = expect.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const T0 = new Date("2026-11-11T06:00:00.000Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const step = (code: string, rate: string, bn: string, en: string): PricingStepInput => ({
  code,
  rate,
  base: "aws",
  label: { bn, en },
});
const LAUNCH: PricingStepInput[] = [
  step("korea_vat", "0.10", "কোরিয়ার VAT", "Korea VAT"),
  step("bd_vat", "0.05", "বাংলাদেশের VAT", "Bangladesh VAT"),
  step("processing_fee", "0.02", "প্রসেসিং ফি", "Processing fee"),
  step("markup", "0", "সার্ভিস চার্জ", "Service charge"),
];
const WITH_MARKUP: PricingStepInput[] = [
  ...LAUNCH.slice(0, 3),
  step("markup", "0.03", "সার্ভিস চার্জ", "Service charge"),
];

let actor: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  actor = {
    adminId: await newAdmin(t.pool, "finance"),
    role: "finance",
    ip: "203.0.113.9",
    userAgent: "test",
  };
});
const as = <T>(fn: (r: AdminRepos) => Promise<T>, role: DatabaseRole = "admin_rw") =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role });
const count = async () =>
  (await t.pool.query("select count(*)::int as n from pricing_rules")).rows[0].n as number;
const audits = () => auditRowsOf(t.pool, actor.adminId);
const save = (over: Record<string, unknown>, reason = "rule change") =>
  as((r) =>
    r.pricingRules.save(
      { market: "BD", productFamily: null, steps: LAUNCH, effectiveFrom: T0, at: T0, ...over },
      reason,
    ),
  );

it("a rule is a new row whose id is its version, with an audit row that carries the steps", async () => {
  const saved = await save({});
  expect(saved).toEqual({
    ok: true,
    replayed: false,
    value: {
      id: UUID7,
      market: "BD",
      productFamily: null,
      steps: LAUNCH,
      effectiveFrom: T0,
      laterChangePending: null,
    },
  });
  const id = (saved as { value: { id: string } }).value.id;
  expect(
    (await t.pool.query("select product_family, steps, set_by from pricing_rules")).rows[0],
  ).toEqual({
    product_family: null,
    steps: LAUNCH,
    set_by: actor.adminId,
  });
  expect(await audits()).toEqual([
    {
      actor_type: "admin",
      action: "pricing_rule.save",
      target_type: "pricing_rule",
      target_id: "BD/*@2026-11-11T06:00:00.000Z",
      ip: "203.0.113.9",
      user_agent: "test",
      metadata: {
        reason: "rule change",
        before: null,
        after: { id, productFamily: null, effectiveFrom: T0.toISOString(), steps: LAUNCH },
      },
    },
  ]);
});

it("the same start with the same steps is a replay (key order and unknown keys do not matter); other steps are a conflict", async () => {
  const n = await count();
  const reordered = LAUNCH.map((s) => ({
    extra: 1,
    label: s.label,
    base: s.base,
    rate: s.rate,
    code: s.code,
  }));
  expect(await save({ steps: reordered }, "retry")).toMatchObject({
    ok: true,
    replayed: true,
    value: { effectiveFrom: T0, steps: LAUNCH },
  });
  expect(await save({ steps: WITH_MARKUP }, "other")).toEqual({ ok: false, error: "conflict" });
  expect(await count()).toBe(n);
});

it("the steps already in force, to start now, add no row (a double click)", async () => {
  const n = await count();
  expect(await save({ effectiveFrom: hours(1), at: hours(1) }, "double click")).toMatchObject({
    ok: true,
    replayed: true,
    value: { effectiveFrom: T0 },
  });
  expect(await count()).toBe(n);
});

it("a family rule with the steps of the market rule is still a new row: it is an override", async () => {
  const saved = await save(
    { productFamily: "linux_instance", effectiveFrom: hours(1), at: hours(1) },
    "override",
  );
  expect(saved).toMatchObject({
    ok: true,
    replayed: false,
    value: { productFamily: "linux_instance" },
  });
  expect(await count()).toBe(2);
  expect((await audits()).at(-1)?.target_id).toBe("BD/linux_instance@2026-11-11T07:00:00.000Z");
});

it("a newer market rule compares with the market rule, not with the family rule, and does not reach the family", async () => {
  expect(
    await save({ steps: WITH_MARKUP, effectiveFrom: hours(2), at: hours(2) }, "service charge"),
  ).toMatchObject({ ok: true, replayed: false });
  expect((await audits()).at(-1)?.metadata).toMatchObject({
    before: { productFamily: null, effectiveFrom: T0.toISOString() },
  });
  const read = (family: string | null) =>
    runTransaction(t.db, (tx) => readPricingRuleInForce(tx, "BD", family, hours(3)), {
      role: "web_rw",
    });
  expect((await read(null))?.steps).toEqual(WITH_MARKUP);
  expect((await read("windows_instance"))?.steps).toEqual(WITH_MARKUP);
  expect((await read("linux_instance"))?.steps).toEqual(LAUNCH);
});

it.each([
  ["steps that are not a list", { steps: "none" }],
  ["a step without an English label", { steps: [{ ...LAUNCH[0], label: { bn: "ক" } }] }],
  ["a step with a base of its own", { steps: [{ ...LAUNCH[0], base: "total" }] }],
  ["a step whose rate is a number", { steps: [{ ...LAUNCH[0], rate: 0.1 }] }],
  ["a family that is not a plain word", { productFamily: "Linux Instance" }],
  ["a market in lower case", { market: "bd" }],
  ["a start before the caller's clock", { effectiveFrom: hours(-1), at: hours(5) }],
])("%s is refused as validation and nothing is written", async (_, over) => {
  const n = await count();
  const a = (await audits()).length;
  expect(await save({ effectiveFrom: hours(5), at: hours(5), ...over })).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await count()).toBe(n);
  expect((await audits()).length).toBe(a);
});

it("a blank reason is refused and nothing is written", async () => {
  const n = await count();
  expect(await save({ steps: WITH_MARKUP, effectiveFrom: hours(5), at: hours(5) }, " ")).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await count()).toBe(n);
});

it("a market that does not exist fails on the foreign key; web_rw cannot write rules", async () => {
  await expect(save({ market: "KE", effectiveFrom: hours(5), at: hours(5) })).rejects.toMatchObject(
    { name: "DbError", code: "23503" },
  );
  await expect(
    as(
      (r) =>
        r.pricingRules.save(
          {
            market: "BD",
            productFamily: null,
            steps: LAUNCH,
            effectiveFrom: hours(6),
            at: hours(6),
          },
          "x",
        ),
      "web_rw",
    ),
  ).rejects.toMatchObject({ name: "DbError", code: "42501" });
});
