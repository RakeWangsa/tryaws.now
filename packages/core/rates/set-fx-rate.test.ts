import { isStorableFxRate, readFxRateInForce, type AdminActor } from "@tc/db";
import { auditRowsOf, ensureMarket, newAdmin, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { isFxRateText } from "../pricing/index";
import { adminActor } from "../test/admin-support";
import { asRole, clockAt } from "../test/rates-support";
import { MAX_SCHEDULE_DAYS, setFxRate, type SetFxRateInput } from "./index";

const t = useTempDatabase();
const T0 = new Date("2026-11-11T06:00:00.000Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

let actor: AdminActor;
let second: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  actor = await adminActor(t, "finance");
  second = await adminActor(t, "superadmin");
});
const set = (input: Partial<SetFxRateInput>, now: Date = T0, as: AdminActor = actor) =>
  asRole(t, "admin_rw", (tx) =>
    setFxRate(
      tx,
      as,
      { market: "BD", rate: "127", reason: "rate change", ...input },
      { now: () => now },
    ),
  );
const count = async () =>
  (await t.pool.query("select count(*)::int as n from fx_rates")).rows[0].n as number;
const audits = () => auditRowsOf(t.pool, actor.adminId);
const inForce = (at: Date) => asRole(t, "web_rw", (tx) => readFxRateInForce(tx, "BD", at));

it("the first rate starts now and is audited with actor, reason, IP and target", async () => {
  const r = await set({ rate: "127", reason: "launch rate" });
  expect(r).toEqual({
    ok: true,
    value: {
      replayed: false,
      fx: { id: expect.any(String), market: "BD", rate: "127", effectiveFrom: T0 },
    },
  });
  expect(await audits()).toMatchObject([
    {
      actor_type: "admin",
      action: "fx_rate.set",
      target_id: "BD@2026-11-11T06:00:00.000Z",
      ip: "203.0.113.9",
      metadata: { reason: "launch rate", before: null },
    },
  ]);
});

it("a change of 5 percent or less needs no second admin", async () => {
  const r = await set({ rate: "130" }, day(1)); // +2.36 percent
  expect(r).toMatchObject({
    ok: true,
    value: { replayed: false, fx: { rate: "130", effectiveFrom: day(1) } },
  });
});

it("a change of more than 5 percent is refused without a second admin, and with the actor as the second admin", async () => {
  const n = await count();
  const a = (await audits()).length;
  expect(await set({ rate: "140" }, day(2))).toEqual({
    ok: false,
    error: "forbidden",
    fields: { requestedBy: "second_admin_required" },
  }); // +7.69 percent
  expect(await set({ rate: "140", requestedBy: actor.adminId }, day(2))).toEqual({
    ok: false,
    error: "forbidden",
    fields: { requestedBy: "must_differ_from_actor" },
  });
  expect(await set({ rate: "140", requestedBy: actor.adminId.toUpperCase() }, day(2))).toEqual({
    ok: false,
    error: "forbidden",
    fields: { requestedBy: "must_differ_from_actor" },
  });
  expect(await count()).toBe(n);
  expect((await audits()).length).toBe(a);
});

it("a second admin that does not exist, or is not finance or superadmin, is refused (not_an_approver)", async () => {
  const n = await count();
  const support = await newAdmin(t.pool, "support");
  const ops = await newAdmin(t.pool, "ops");
  const gone = "01900000-0000-7000-8000-000000000000";
  for (const requestedBy of [support, ops, gone]) {
    expect(await set({ rate: "140", requestedBy }, day(2)), requestedBy).toEqual({
      ok: false,
      error: "forbidden",
      fields: { requestedBy: "not_an_approver" },
    });
  }
  const disabled = await newAdmin(t.pool, "superadmin");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [disabled]);
  expect(await set({ rate: "140", requestedBy: disabled }, day(2))).toEqual({
    ok: false,
    error: "forbidden",
    fields: { requestedBy: "not_an_approver" },
  });
  expect(await count()).toBe(n);
});

it("with a second admin the change is saved and the audit row records who asked", async () => {
  const r = await set({ rate: "140", requestedBy: second.adminId }, day(2));
  expect(r).toMatchObject({ ok: true, value: { replayed: false, fx: { rate: "140" } } });
  expect((await audits()).at(-1)?.metadata).toMatchObject({
    reason: "rate change",
    before: { rate: "130" },
    after: { rate: "140", approvedBy: second.adminId },
  });
});

it("exactly 5 percent is allowed; a rate a tenth of the old one is not (14.7 for 147)", async () => {
  expect(await set({ rate: "147" }, day(3))).toMatchObject({
    ok: true,
    value: { fx: { rate: "147" } },
  }); // 140 x 1.05
  expect(await set({ rate: "14.7" }, day(4))).toEqual({
    ok: false,
    error: "forbidden",
    fields: { requestedBy: "second_admin_required" },
  });
});

it("the same rate again, to start now, adds no row", async () => {
  const n = await count();
  expect(await set({ rate: "147.00" }, day(5))).toMatchObject({
    ok: true,
    value: { replayed: true, fx: { rate: "147" } },
  });
  expect(await count()).toBe(n);
});

it("a change can be scheduled: it is not in force before its start and is from its start on", async () => {
  const start = day(5 + 7);
  expect(await set({ rate: "150", effectiveFrom: start }, day(5))).toMatchObject({
    ok: true,
    value: { replayed: false },
  });
  expect((await inForce(new Date(start.getTime() - 1)))?.rate).toBe("147");
  expect((await inForce(start))?.rate).toBe("150");
});

it("the same start again with the same rate is a replay; with another rate it is a conflict", async () => {
  const start = day(5 + 7);
  const n = await count();
  expect(await set({ rate: "150", effectiveFrom: start }, day(6))).toMatchObject({
    ok: true,
    value: { replayed: true },
  });
  expect(await set({ rate: "151", effectiveFrom: start }, day(6))).toEqual({
    ok: false,
    error: "conflict",
    fields: { effectiveFrom: "taken_by_another_rate" },
  });
  expect(await count()).toBe(n);
});

it(`a start up to ${MAX_SCHEDULE_DAYS} days ahead is accepted; one millisecond further, or in the past, is refused`, async () => {
  const now = day(6);
  const limit = new Date(now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000);
  expect(MAX_SCHEDULE_DAYS).toBe(90);
  expect(await set({ rate: "151", effectiveFrom: limit }, now)).toMatchObject({ ok: true });
  expect(await set({ rate: "152", effectiveFrom: new Date(limit.getTime() + 1) }, now)).toEqual({
    ok: false,
    error: "validation",
    fields: { effectiveFrom: "too_far_ahead" },
  });
  expect(await set({ rate: "152", effectiveFrom: new Date(now.getTime() - 1) }, now)).toEqual({
    ok: false,
    error: "validation",
    fields: { effectiveFrom: "in_the_past" },
  });
});

it.each([
  ["seven decimals", { rate: "127.1234567" }, { rate: "invalid" }],
  ["seven digits before the point", { rate: "1000000" }, { rate: "invalid" }],
  ["zero", { rate: "0" }, { rate: "invalid" }],
  ["text", { rate: "abc" }, { rate: "invalid" }],
  ["a market in lower case", { market: "bd" }, { market: "invalid" }],
  ["a market that does not exist", { market: "KE" }, { market: "unknown" }],
  ["a blank reason", { reason: "   " }, { reason: "required" }],
  ["a reason of 501 characters", { reason: "x".repeat(501) }, { reason: "too_long" }],
  ["a second admin that is no id", { requestedBy: "x" }, { requestedBy: "invalid" }],
  ["an invalid date", { effectiveFrom: new Date("nope") }, { effectiveFrom: "invalid" }],
])(
  "%s is a validation failure that names the field, and nothing is written",
  async (_, over, fields) => {
    const n = await count();
    const a = (await audits()).length;
    expect(await set(over, day(7))).toEqual({ ok: false, error: "validation", fields });
    expect(await count()).toBe(n);
    expect((await audits()).length).toBe(a);
  },
);

it("web_rw cannot save a rate: the database refuses with 42501 (section 3.3)", async () => {
  await expect(
    asRole(t, "web_rw", (tx) =>
      setFxRate(
        tx,
        actor,
        { market: "BD", rate: "153", reason: "x" },
        clockAt("2026-12-01T00:00:00Z"),
      ),
    ),
  ).rejects.toMatchObject({ name: "DbError", code: "42501" });
});

it("the rate check of the core and the check of the repository accept and refuse the same texts", () => {
  const samples = [
    "127",
    "124.77",
    "0.5",
    "0.000001",
    "999999.999999",
    "127.0",
    "",
    "0",
    "0.0",
    "-1",
    "1e3",
    " 127",
    "127.1234567",
    "1000000",
    "00.5",
    ".5",
    "5.",
    "1,5",
  ];
  for (const s of samples) expect(isFxRateText(s), s).toBe(isStorableFxRate(s));
});
