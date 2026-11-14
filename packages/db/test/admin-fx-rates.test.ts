import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { readFxRateInForce } from "../repositories/config/fx-rates";
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

let actor: AdminActor;
let second: string;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  actor = {
    adminId: await newAdmin(t.pool, "finance"),
    role: "finance",
    ip: "203.0.113.9",
    userAgent: "test",
  };
  second = await newAdmin(t.pool, "superadmin");
});
const as = <T>(fn: (r: AdminRepos) => Promise<T>, role: DatabaseRole = "admin_rw") =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role });
const count = async () =>
  (await t.pool.query("select count(*)::int as n from fx_rates")).rows[0].n as number;
const audits = () => auditRowsOf(t.pool, actor.adminId);

it("the first rate is a new row with its start, its author and one audit row with actor, reason, IP and target", async () => {
  const set = await as((r) =>
    r.fxRates.set({ market: "BD", rate: "127", effectiveFrom: T0, at: T0 }, "launch rate"),
  );
  expect(set).toEqual({
    ok: true,
    replayed: false,
    value: {
      id: UUID7,
      market: "BD",
      rate: "127",
      effectiveFrom: T0,
      laterChangePending: null,
      createdAt: expect.any(Date),
    },
  });
  expect((await t.pool.query("select rate::text as rate, set_by from fx_rates")).rows[0]).toEqual({
    rate: "127.000000",
    set_by: actor.adminId,
  });
  const id = (set as { value: { id: string } }).value.id;
  expect(await audits()).toEqual([
    {
      actor_type: "admin",
      action: "fx_rate.set",
      target_type: "fx_rate",
      target_id: "BD@2026-11-11T06:00:00.000Z",
      ip: "203.0.113.9",
      user_agent: "test",
      metadata: {
        reason: "launch rate",
        before: null,
        after: { id, market: "BD", rate: "127", effectiveFrom: T0.toISOString() },
      },
    },
  ]);
});

it("a later rate is stored in canonical text, and the audit row records the old row and the second admin", async () => {
  const first = await as((r) =>
    r.fxRates.set({ market: "BD", rate: "127", effectiveFrom: T0, at: T0 }, "again"),
  );
  const firstId = (first as { value: { id: string } }).value.id;
  const set = await as((r) =>
    r.fxRates.set(
      {
        market: "BD",
        rate: "130.50",
        effectiveFrom: hours(1),
        at: hours(1),
        approvedBy: second.toUpperCase(),
      },
      "new rate",
    ),
  );
  expect(set).toMatchObject({
    ok: true,
    replayed: false,
    value: { rate: "130.5", effectiveFrom: hours(1) },
  });
  expect((await audits()).at(-1)?.metadata).toMatchObject({
    reason: "new rate",
    before: { id: firstId, market: "BD", rate: "127", effectiveFrom: T0.toISOString() },
    after: { rate: "130.5", effectiveFrom: hours(1).toISOString(), approvedBy: second }, // stored in lower case
  });
});

it("the same start with the same rate is a replay of the same row; with another rate it is a conflict and writes nothing", async () => {
  const n = await count();
  const a = (await audits()).length;
  const replay = await as((r) =>
    r.fxRates.set({ market: "BD", rate: "127.0", effectiveFrom: T0, at: T0 }, "retry"),
  );
  expect(replay).toMatchObject({
    ok: true,
    replayed: true,
    value: { rate: "127", effectiveFrom: T0 },
  });
  expect(await count()).toBe(n);
  expect(await audits()).toHaveLength(a + 1); // the call is audited, the state is not changed
  expect(
    await as((r) =>
      r.fxRates.set({ market: "BD", rate: "128", effectiveFrom: T0, at: T0 }, "other"),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await count()).toBe(n);
  expect(await audits()).toHaveLength(a + 1);
});

it("setting the rate that is already in force, to start now, adds no row (a double click)", async () => {
  const n = await count();
  const set = await as((r) =>
    r.fxRates.set(
      { market: "BD", rate: "130.5", effectiveFrom: hours(2), at: hours(2) },
      "double click",
    ),
  );
  expect(set).toMatchObject({
    ok: true,
    replayed: true,
    value: { rate: "130.5", effectiveFrom: hours(1) },
  });
  expect(await count()).toBe(n);
});

it("a rate that starts later waits: it is not in force before its start and is from its start on", async () => {
  const start = hours(26);
  expect(
    await as((r) =>
      r.fxRates.set({ market: "BD", rate: "131", effectiveFrom: start, at: hours(2) }, "scheduled"),
    ),
  ).toMatchObject({ ok: true, replayed: false });
  const read = (when: Date) =>
    runTransaction(t.db, (tx) => readFxRateInForce(tx, "BD", when), { role: "web_rw" });
  expect((await read(new Date(start.getTime() - 1)))?.rate).toBe("130.5");
  expect((await read(start))?.rate).toBe("131");
});

it.each([
  ["a rate with seven decimals", { rate: "127.1234567" }],
  ["a rate with seven digits before the point", { rate: "1000000" }],
  ["a rate of zero", { rate: "0" }],
  ["a rate that is not a number", { rate: "abc" }],
  ["an empty rate", { rate: "" }],
  ["a market in lower case", { market: "bd" }],
  ["a start before the caller's clock", { effectiveFrom: hours(-1) }],
  ["a second admin that is not an id", { approvedBy: "not-an-id" }],
  ["an unknown approval ground (WPU-X9)", { approval: "anything" }],
  [
    "a single-admin ground together with a second admin (WPU-X9)",
    { approval: "single_admin_within_limit", approvedBy: "0191a000-0000-7000-8000-0000000000ae" },
  ],
])("%s is refused as validation and nothing is written", async (_, over) => {
  const n = await count();
  const a = (await audits()).length;
  const input = { market: "BD", rate: "140", effectiveFrom: hours(3), at: hours(3), ...over };
  // `as never`: some cases hold values the type refuses (an unknown approval ground), to test the runtime check.
  expect(await as((r) => r.fxRates.set(input as never, "x"))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await count()).toBe(n);
  expect((await audits()).length).toBe(a);
});

it("the rate in force, saved again while a later change is scheduled, is a replay that reports the pending change", async () => {
  const later = hours(60);
  await as((r) =>
    r.fxRates.set({ market: "BD", rate: "132", effectiveFrom: later, at: hours(30) }, "scheduled"),
  );
  const n = await count();
  const replay = await as((r) =>
    r.fxRates.set(
      { market: "BD", rate: "131", effectiveFrom: hours(31), at: hours(31) },
      "cancel?",
    ),
  );
  expect(replay).toMatchObject({
    ok: true,
    replayed: true,
    value: { rate: "131", laterChangePending: later },
  });
  expect(await count()).toBe(n); // nothing is withdrawn
  // the way to correct a scheduled row: a row that starts one millisecond after it
  const fix = await as((r) =>
    r.fxRates.set(
      { market: "BD", rate: "131", effectiveFrom: new Date(later.getTime() + 1), at: hours(31) },
      "supersede",
    ),
  );
  expect(fix).toMatchObject({ ok: true, replayed: false, value: { rate: "131" } });
  const read = (when: Date) =>
    runTransaction(t.db, (tx) => readFxRateInForce(tx, "BD", when), { role: "web_rw" });
  expect([(await read(later))?.rate, (await read(new Date(later.getTime() + 1)))?.rate]).toEqual([
    "132",
    "131",
  ]);
});

it("two requests for the same value at the same moment: one row, and the second answers replayed (per-market lock)", async () => {
  const n = await count();
  const first = runTransaction(
    t.db,
    async (tx) => {
      const r = await adminRepos(tx, actor).fxRates.set(
        { market: "BD", rate: "133", effectiveFrom: hours(80), at: hours(80) },
        "click 1",
      );
      await tx.execute("select pg_sleep(0.5)");
      return r;
    },
    { role: "admin_rw" },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const at2 = new Date(hours(80).getTime() + 150);
  const second = as((r) =>
    r.fxRates.set({ market: "BD", rate: "133", effectiveFrom: at2, at: at2 }, "click 2"),
  );
  const [a, b] = await Promise.all([first, second]);
  expect(a).toMatchObject({ ok: true, replayed: false });
  expect(b).toMatchObject({ ok: true, replayed: true, value: { rate: "133" } });
  expect(await count()).toBe(n + 1);
});

it("a blank reason is refused and nothing is written", async () => {
  const n = await count();
  expect(
    await as((r) =>
      r.fxRates.set({ market: "BD", rate: "140", effectiveFrom: hours(3), at: hours(3) }, "   "),
    ),
  ).toEqual({ ok: false, error: "validation" });
  expect(await count()).toBe(n);
});

it("a market that does not exist fails on the foreign key and the whole transaction rolls back", async () => {
  await expect(
    as((r) =>
      r.fxRates.set({ market: "KE", rate: "1.25", effectiveFrom: hours(3), at: hours(3) }, "x"),
    ),
  ).rejects.toMatchObject({
    name: "DbError",
    code: "23503",
    constraint: "fx_rates_market_markets_code_fk",
  });
});

it("web_rw cannot write rates (section 3.3): the insert fails with 42501", async () => {
  await expect(
    as(
      (r) =>
        r.fxRates.set({ market: "BD", rate: "140", effectiveFrom: hours(3), at: hours(3) }, "x"),
      "web_rw",
    ),
  ).rejects.toMatchObject({
    name: "DbError",
    code: "42501",
  });
});

it("no role edits or deletes a rate: admin_rw has no grant and the trigger stops the owner", async () => {
  for (const sqlText of ["update fx_rates set rate = 1", "delete from fx_rates"]) {
    await expect(
      runTransaction(t.db, (tx) => tx.execute(sqlText), { role: "admin_rw" }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(t.pool.query(sqlText)).rejects.toMatchObject({ code: "23001" });
  }
});

it("WPU-X9: a rate set by one admin records its ground (approval) in the audit row and names no second admin", async () => {
  const start = hours(500);
  const set = await as((r) =>
    r.fxRates.set(
      {
        market: "BD",
        rate: "134",
        effectiveFrom: start,
        at: start,
        approval: "single_admin_within_limit",
      },
      "bank moved a little",
    ),
  );
  expect(set).toMatchObject({ ok: true, replayed: false, value: { rate: "134" } });
  const metadata = (await audits()).at(-1)?.metadata as { after: Record<string, unknown> };
  expect(metadata).toMatchObject({
    reason: "bank moved a little",
    after: { rate: "134", approval: "single_admin_within_limit" },
  });
  expect(metadata.after).not.toHaveProperty("approvedBy");
});
