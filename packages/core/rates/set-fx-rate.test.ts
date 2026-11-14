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
// A four-eyes change (WPU-Y1): `actor` approves here; `second` is the admin who asked.
const set = (input: Partial<SetFxRateInput>, now: Date = T0, as: AdminActor = actor) =>
  asRole(t, "admin_rw", (tx) =>
    setFxRate(
      tx,
      as,
      { market: "BD", rate: "127", reason: "rate change", requestedBy: second.adminId, ...input },
      { now: () => now },
    ),
  );
// WPU-X9 (owner decision 2026-11-14, "alone, within ±3%"): the same call without a second admin.
const alone = (input: Partial<SetFxRateInput>, now: Date = T0, as: AdminActor = actor) =>
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
const SECOND_ADMIN = {
  ok: false,
  error: "forbidden",
  fields: { requestedBy: "second_admin_required" },
};

// Before WPU-X9 the first rate needed a second admin too (WPU-Y1, owner decision 3). Owner decision 2026-11-14:
// one admin sets the first rate of a market alone; the audit row records the ground and names no second admin.
it("WPU-X9: the first rate of a market is set by one admin, starts now and is audited with its ground", async () => {
  const r = await alone({ rate: "127", reason: "launch rate" });
  expect(r).toEqual({
    ok: true,
    value: {
      replayed: false,
      fx: {
        id: expect.any(String),
        market: "BD",
        rate: "127",
        effectiveFrom: T0,
        createdAt: expect.any(Date),
      },
    },
  });
  const rows = await audits();
  expect(rows).toMatchObject([
    {
      actor_type: "admin",
      action: "fx_rate.set",
      target_id: "BD@2026-11-11T06:00:00.000Z",
      ip: "203.0.113.9",
      metadata: {
        reason: "launch rate",
        before: null,
        after: { rate: "127", approval: "single_admin_first_rate" },
      },
    },
  ]);
  expect((rows[0]?.metadata as { after: object }).after).not.toHaveProperty("approvedBy");
  // the same call again is a replay (R7): no second row
  const n = await count();
  expect(await alone({ rate: "127", reason: "launch rate" })).toMatchObject({
    ok: true,
    value: { replayed: true },
  });
  expect(await count()).toBe(n);
});

it("WPU-X9: one admin alone may change the rate by at most 3 percent; 3.000001 percent needs a second admin", async () => {
  const n = await count();
  const a = (await audits()).length;
  expect(await alone({ rate: "130.810001" }, day(1))).toEqual(SECOND_ADMIN); // +3.0000008 percent of 127
  expect(await alone({ rate: "123.189999" }, day(1))).toEqual(SECOND_ADMIN); // -3.0000008 percent
  expect(await alone({ rate: "150" }, day(1))).toEqual(SECOND_ADMIN);
  expect(await count()).toBe(n);
  expect((await audits()).length).toBe(a);
  // exactly +3 percent (127 x 1.03) is in force at once
  expect(await alone({ rate: "130.81", reason: "bank moved" }, day(1))).toMatchObject({
    ok: true,
    value: { replayed: false, fx: { rate: "130.81", effectiveFrom: day(1) } },
  });
  expect((await inForce(day(1)))?.rate).toBe("130.81");
  expect((await audits()).at(-1)?.metadata).toMatchObject({
    reason: "bank moved",
    before: { rate: "127" },
    after: { rate: "130.81", approval: "single_admin_within_limit" },
  });
});

it("WPU-X9: an admin who may not approve rates (support, ops) cannot set one alone", async () => {
  const n = await count();
  for (const role of ["support", "ops"] as const) {
    const other = await adminActor(t, role);
    expect(await alone({ rate: "130.81" }, day(1), other)).toEqual({
      ok: false,
      error: "forbidden",
      fields: { requestedBy: "not_an_approver" },
    });
  }
  expect(await count()).toBe(n);
});

it("WPU-X9: no rate in force while a rate is stored for later is no first rate: it needs a second admin", async () => {
  await ensureMarket(t.pool, "LK");
  const lk = (input: Partial<SetFxRateInput>, now: Date) => alone({ market: "LK", ...input }, now);
  // the very first row of LK, scheduled for later: a first rate, alone
  expect(await lk({ rate: "2.5", effectiveFrom: day(3) }, T0)).toMatchObject({ ok: true });
  // before its start nothing is in force, but a row exists: fail closed to four eyes
  expect(await lk({ rate: "2.5" }, day(1))).toEqual(SECOND_ADMIN);
});

it("WPU-X9: a scheduled change alone must be within 3 percent of the rate in force now AND at its start", async () => {
  await ensureMarket(t.pool, "NP");
  const np = (input: Partial<SetFxRateInput>, now: Date) => alone({ market: "NP", ...input }, now);
  expect(await np({ rate: "100" }, T0)).toMatchObject({ ok: true }); // first rate
  expect(await np({ rate: "103", effectiveFrom: day(2) }, T0)).toMatchObject({ ok: true }); // +3
  // 100 -> 97 at day 4 is -3 percent of now, but -5.8 percent of the 103 that will be in force then
  expect(await np({ rate: "97", effectiveFrom: day(4) }, T0)).toEqual(SECOND_ADMIN);
  expect(await np({ rate: "101", effectiveFrom: day(4) }, T0)).toMatchObject({ ok: true });
});

// WPU-X9 fix round 1 (owner decision 2026-11-14, "Yes: 3% per 24 hours"; money and security review findings).
const HOUR = 3_600_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

it("WPU-X9 round 1: chained steps cannot add up: the second -3 percent step within 24 hours needs a second admin", async () => {
  await ensureMarket(t.pool, "AF");
  const af = (rate: string, now: Date) => alone({ market: "AF", rate }, now);
  expect(await af("122", T0)).toMatchObject({ ok: true }); // first rate
  expect(await af("118.34", at(HOUR))).toMatchObject({ ok: true }); // -3 percent
  // -3 percent of 118.34, but -5.9 percent of the 122 in force 1 hour ago
  expect(await af("114.79", at(2 * HOUR))).toEqual(SECOND_ADMIN);
  // 24 hours and 1 second after the 118.34 step, 122 has left the window: the step passes alone
  expect(await af("114.79", at(HOUR + 24 * HOUR + 1000))).toMatchObject({
    ok: true,
    value: { replayed: false, fx: { rate: "114.79" } },
  });
});

it("WPU-X9 round 1: exactly 3 percent from the oldest rate of the window passes alone; past it does not", async () => {
  await ensureMarket(t.pool, "MM");
  const mm = (rate: string, now: Date) => alone({ market: "MM", rate }, now);
  expect(await mm("100", T0)).toMatchObject({ ok: true });
  expect(await mm("102", at(HOUR))).toMatchObject({ ok: true });
  expect(await mm("103.000001", at(2 * HOUR))).toEqual(SECOND_ADMIN);
  expect(await mm("103", at(2 * HOUR))).toMatchObject({ ok: true }); // +3 percent of 100, +0.98 of 102
});

it("WPU-X9 round 1: no single-admin change before a rate that is already scheduled later", async () => {
  await ensureMarket(t.pool, "BT");
  const bt = (input: Partial<SetFxRateInput>, now: Date) => alone({ market: "BT", ...input }, now);
  expect(await bt({ rate: "100" }, T0)).toMatchObject({ ok: true });
  expect(await bt({ rate: "101", effectiveFrom: day(2) }, T0)).toMatchObject({ ok: true });
  const n = await count();
  // an immediate change while 101 waits for day 2
  expect(await bt({ rate: "100.5" }, at(HOUR))).toEqual(SECOND_ADMIN);
  // a scheduled change that would start before the row of day 2
  expect(await bt({ rate: "100.5", effectiveFrom: day(1) }, at(HOUR))).toEqual(SECOND_ADMIN);
  expect(await count()).toBe(n);
  // the four-eyes path still may
  expect(await set({ market: "BT", rate: "100.5" }, at(HOUR))).toMatchObject({ ok: true });
});

// WPU-X9: a change within 3 percent no longer needs a second admin (see above); a named second admin is still checked.
it("a named second admin is refused when it is the actor", async () => {
  const n = await count();
  const a = (await audits()).length;
  expect(await set({ rate: "128", requestedBy: actor.adminId }, day(1))).toEqual({
    ok: false,
    error: "forbidden",
    fields: { requestedBy: "must_differ_from_actor" },
  });
  expect(await set({ rate: "128", requestedBy: actor.adminId.toUpperCase() }, day(1))).toEqual({
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
    expect(await set({ rate: "130", requestedBy }, day(2)), requestedBy).toEqual({
      ok: false,
      error: "forbidden",
      fields: { requestedBy: "not_an_approver" },
    });
  }
  const disabled = await newAdmin(t.pool, "superadmin");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [disabled]);
  expect(await set({ rate: "130", requestedBy: disabled }, day(2))).toEqual({
    ok: false,
    error: "forbidden",
    fields: { requestedBy: "not_an_approver" },
  });
  expect(await count()).toBe(n);
});

it("with a second admin the change is saved and the audit row records who asked (and no single-admin ground)", async () => {
  const r = await set({ rate: "130" }, day(2));
  expect(r).toMatchObject({ ok: true, value: { replayed: false, fx: { rate: "130" } } });
  const metadata = (await audits()).at(-1)?.metadata as { after: object };
  expect(metadata).toMatchObject({
    reason: "rate change",
    before: { rate: "130.81" },
    after: { rate: "130", approvedBy: second.adminId },
  });
  expect(metadata.after).not.toHaveProperty("approval");
});

it("WPU-X9: a change of more than 3 percent is set when a second admin approved it (the four-eyes path is unchanged)", async () => {
  await ensureMarket(t.pool, "MV");
  expect(await alone({ market: "MV", rate: "15" }, T0)).toMatchObject({ ok: true }); // first rate
  expect(await alone({ market: "MV", rate: "16" }, day(1))).toEqual(SECOND_ADMIN); // +6.7 percent
  expect(await set({ market: "MV", rate: "16" }, day(1))).toMatchObject({
    ok: true,
    value: { fx: { rate: "16" } },
  });
});

it("the same rate again, to start now, is a re-confirm: it adds a row and restarts the age of the rate", async () => {
  const n = await count();
  expect(await set({ rate: "130.00" }, day(5))).toMatchObject({
    ok: true,
    value: { replayed: false, fx: { rate: "130", effectiveFrom: day(5) } },
  });
  expect(await count()).toBe(n + 1);
  expect((await inForce(day(5)))?.effectiveFrom).toEqual(day(5));
  // the same call again at the same instant is a replay, not a second row
  expect(await set({ rate: "130" }, day(5))).toMatchObject({ ok: true, value: { replayed: true } });
  expect(await count()).toBe(n + 1);
});

it("a change can be scheduled: it is not in force before its start and is from its start on", async () => {
  const start = day(5 + 7);
  expect(await set({ rate: "150", effectiveFrom: start }, day(5))).toMatchObject({
    ok: true,
    value: { replayed: false },
  });
  expect((await inForce(new Date(start.getTime() - 1)))?.rate).toBe("130");
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

it("a rate starts at most 7 days ahead (WPU-Y9); one millisecond further, or in the past, is refused", async () => {
  const now = day(6);
  const limit = new Date(now.getTime() + 7 * 86_400_000);
  expect(MAX_SCHEDULE_DAYS).toBe(90); // the limit of the other changes (rules, books) is unchanged
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
        { market: "BD", rate: "153", reason: "x", requestedBy: second.adminId },
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
