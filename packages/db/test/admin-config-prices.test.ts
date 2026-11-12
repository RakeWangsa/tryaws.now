import { beforeAll, expect, it } from "vitest";
import type { ConfigPriceInput } from "../repositories/admin/config-prices";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { entryOfConfigPriceAt, parseConfigPriceValue } from "../repositories/config/config-price";
import { readConfigPrices } from "../seed/config-prices";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-G10: the config prices (load balancer, snapshot, block storage, hosted zone) get dated entries,
// an audit row and a role check, as the price book of WPA-P1. The read picks the entry in force.
const t = useTempDatabase();
const T0 = new Date("2026-11-11T06:00:00.000Z");
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const LB = "config_price.load_balancer_month";
const DNS = "config_price.dns_zone_month";

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
const as = <T>(fn: (r: AdminRepos) => Promise<T>, a: AdminActor = actor) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
// `over` may hold values the type forbids on purpose (the refusal test), so the result is cast once here.
const input = (over: Record<string, unknown> = {}): ConfigPriceInput =>
  ({
    market: "BD",
    key: LB,
    usd: "18",
    effectiveFrom: T0,
    at: T0,
    ...over,
  }) as ConfigPriceInput;
const stored = async (key: string) =>
  (await t.pool.query("select value from settings where key = $1", [key])).rows;

it("parses the legacy value of the seed and the dated value, and refuses anything else (R16)", () => {
  const legacy = parseConfigPriceValue(LB, { usd: "18", unit: "month" });
  expect(legacy).toHaveLength(1);
  expect(legacy?.[0]?.usd).toBe("18");
  expect(parseConfigPriceValue(LB, { usd: "18", unit: "gb_month" })).toBeNull();
  expect(parseConfigPriceValue(LB, { usd: 18, unit: "month" })).toBeNull();
  expect(parseConfigPriceValue(LB, { v: 1, unit: "month", entries: [] })).toBeNull();
  const dated = {
    v: 1,
    unit: "month",
    entries: [
      { from: T0.toISOString(), usd: "18", by: null },
      { from: days(5).toISOString(), usd: "20", by: null },
    ],
  };
  const parsed = parseConfigPriceValue(LB, dated);
  expect(entryOfConfigPriceAt(parsed ?? [], days(4))?.usd).toBe("18");
  expect(entryOfConfigPriceAt(parsed ?? [], days(5))?.usd).toBe("20");
  expect(entryOfConfigPriceAt(parsed ?? [], new Date(T0.getTime() - 1))).toBeNull();
  // entries out of order
  expect(parseConfigPriceValue(LB, { ...dated, entries: [...dated.entries].reverse() })).toBeNull();
});

it("the first save is a settings row with one entry and one audit row (actor, reason, IP, target)", async () => {
  const saved = await as((r) => r.configPrices.save(input(), "launch value"));
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(saved.replayed).toBe(false);
  expect((await stored(LB))[0].value).toEqual({
    v: 1,
    unit: "month",
    entries: [{ from: T0.toISOString(), usd: "18", by: actor.adminId }],
  });
  const audits = (await auditRowsOf(t.pool, actor.adminId)).filter(
    (a) => a.action === "config_price.save",
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_type: "admin",
    target_type: "config_price",
    target_id: `BD/${LB}@${T0.toISOString()}`,
    ip: "203.0.113.9",
  });
  expect(audits[0]?.metadata.reason).toBe("launch value");
});

it("the same request is a replay; the same start with another price is a conflict", async () => {
  expect(await as((r) => r.configPrices.save(input(), "again"))).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(await as((r) => r.configPrices.save(input({ usd: "19" }), "x"))).toEqual({
    ok: false,
    error: "conflict",
  });
});

it("a later start is a scheduled change: new orders read the entry in force at their own instant", async () => {
  const later = await as((r) =>
    r.configPrices.save(input({ usd: "21.5", effectiveFrom: days(10) }), "from the 10th"),
  );
  expect(later).toMatchObject({ ok: true, replayed: false });
  const now = await runTransaction(t.db, (tx) => readConfigPrices(tx, "BD", days(9)), {
    role: "worker_rw",
  });
  const after = await runTransaction(t.db, (tx) => readConfigPrices(tx, "BD", days(10)), {
    role: "worker_rw",
  });
  expect(now[LB]).toEqual({ usd: "18", unit: "month" });
  expect(after[LB]).toEqual({ usd: "21.5", unit: "month" });
  const read = await as((r) => r.configPrices.read("BD"));
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.value.rows.find((x) => x.key === LB)?.entries).toHaveLength(2);
});

it("a legacy row of the seed becomes the first entry of the history when an admin saves over it", async () => {
  await t.pool.query(
    `insert into settings (id, key, market, scope, scope_id, value)
     values (gen_random_uuid(), $1, 'BD', 'market', null, '{"usd":"0.50","unit":"month"}'::jsonb)`,
    [DNS],
  );
  const saved = await as((r) =>
    r.configPrices.save(input({ key: DNS, usd: "0.60", effectiveFrom: days(1) }), "raise"),
  );
  expect(saved.ok).toBe(true);
  const value = (await stored(DNS))[0].value;
  expect(value.entries).toHaveLength(2);
  expect(value.entries[0]).toMatchObject({ usd: "0.50", by: null });
  const audits = (await auditRowsOf(t.pool, actor.adminId)).filter(
    (a) => a.action === "config_price.save",
  );
  expect(audits.at(-1)?.metadata.before).toMatchObject({ usd: "0.50" });
});

it("refuses a key that is no config price, a price of zero or with a sign, a past start, a start too far away", async () => {
  const bad = [
    input({ key: "config_price.other" }),
    input({ key: "price_book.linux_instance" }),
    input({ usd: "0" }),
    input({ usd: "0.0000" }),
    input({ usd: "-1" }),
    input({ usd: "1e3" }),
    input({ usd: "1.23456" }),
    input({ usd: 5 }),
    input({ market: "bd" }),
    input({ effectiveFrom: new Date(T0.getTime() - 1) }),
    input({ effectiveFrom: days(91) }),
    input({ effectiveFrom: "2026-11-11" }),
  ];
  for (const b of bad) {
    expect(await as((r) => r.configPrices.save(b as never, "r")), JSON.stringify(b)).toEqual({
      ok: false,
      error: "validation",
    });
  }
});

it("only finance and superadmin read and write; ops and support are refused and write nothing", async () => {
  for (const role of ["ops", "support"] as const) {
    const other: AdminActor = {
      adminId: await newAdmin(t.pool, role),
      role,
      ip: "203.0.113.9",
      userAgent: "test",
    };
    expect(await as((r) => r.configPrices.read("BD"), other)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await as((r) => r.configPrices.save(input({ usd: "30" }), "r"), other)).toEqual({
      ok: false,
      error: "forbidden",
    });
  }
  expect((await stored(LB))[0].value.entries).toHaveLength(2);
});

it("a stored value that does not parse is reported as invalid and replaced by a save (R16)", async () => {
  await t.pool.query(`update settings set value = '{"v":9}'::jsonb where key = $1`, [LB]);
  const read = await as((r) => r.configPrices.read("BD"));
  expect(read.ok && read.value.invalid).toContain(LB);
  const prices = await runTransaction(t.db, (tx) => readConfigPrices(tx, "BD", days(20)), {
    role: "worker_rw",
  });
  expect(prices[LB]).toBeUndefined();
  expect(await as((r) => r.configPrices.save(input({ usd: "17" }), "fix"))).toMatchObject({
    ok: true,
  });
});
