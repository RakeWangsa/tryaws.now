import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { parseTierLimitsValue, readTierLimits } from "../repositories/config/tier-limits";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-G10: the limits of a risk tier are a setting of scope `tier` for each market. No row means the
// defaults of the core; a row that does not parse is `invalid` and the caller refuses (R16).
const t = useTempDatabase();
let actor: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  actor = {
    adminId: await newAdmin(t.pool, "superadmin"),
    role: "superadmin",
    ip: "203.0.113.9",
    userAgent: "test",
  };
});
const as = <T>(fn: (r: AdminRepos) => Promise<T>, a: AdminActor = actor) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const limits = {
  maxInstances: 7,
  maxBundleUsd: "40",
  windows: true,
  containers: false,
  maxStaticIps: 2,
};
const stored = async () =>
  (await t.pool.query("select scope, scope_id, value from settings where key = 'tier_limits'"))
    .rows;
const readAs = (tier: "new" | "trusted") =>
  runTransaction(t.db, (tx) => readTierLimits(tx, "BD", tier), { role: "web_rw" });

it("parses a value and refuses what is not a whole, bounded limit", () => {
  expect(parseTierLimitsValue({ v: 1, ...limits })).toEqual(limits);
  for (const bad of [
    null,
    {},
    { v: 2, ...limits },
    { v: 1, ...limits, maxInstances: 0 },
    { v: 1, ...limits, maxInstances: 1.5 },
    { v: 1, ...limits, maxInstances: 100001 },
    { v: 1, ...limits, maxBundleUsd: "-1" },
    { v: 1, ...limits, maxBundleUsd: "1e3" },
    { v: 1, ...limits, windows: "yes" },
    { v: 1, ...limits, maxStaticIps: -1 },
    { v: 1, ...limits, extra: 1 },
  ]) {
    expect(parseTierLimitsValue(bad), JSON.stringify(bad)).toBeNull();
  }
});

it("no row reads as none (the caller uses the defaults)", async () => {
  expect(await readAs("new")).toEqual({ state: "none" });
});

it("a save writes one row of scope tier with the tier as scope id, and audits actor, reason, IP and target", async () => {
  const saved = await as((r) =>
    r.tierLimits.save({ market: "BD", tier: "new", limits }, "pilot customers need more"),
  );
  expect(saved).toMatchObject({ ok: true, replayed: false });
  expect(await stored()).toEqual([{ scope: "tier", scope_id: "new", value: { v: 1, ...limits } }]);
  const audits = (await auditRowsOf(t.pool, actor.adminId)).filter(
    (a) => a.action === "tier_limits.save",
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    target_type: "tier_limits",
    target_id: "BD/new",
    ip: "203.0.113.9",
  });
  expect(audits[0]?.metadata.reason).toBe("pilot customers need more");
  expect(audits[0]?.metadata.after).toMatchObject({ maxInstances: 7 });
  expect(await readAs("new")).toEqual({ state: "ok", limits });
  expect(await readAs("trusted")).toEqual({ state: "none" });
});

it("the same limits again are a replay (the audit row says so); other limits change the row", async () => {
  const again = await as((r) => r.tierLimits.save({ market: "BD", tier: "new", limits }, "again"));
  expect(again).toMatchObject({ ok: true, replayed: true });
  const changed = await as((r) =>
    r.tierLimits.save(
      { market: "BD", tier: "new", limits: { ...limits, maxInstances: 9 } },
      "more",
    ),
  );
  expect(changed).toMatchObject({ ok: true, replayed: false });
  expect((await stored())[0]?.value.maxInstances).toBe(9);
  const audits = (await auditRowsOf(t.pool, actor.adminId)).filter(
    (a) => a.action === "tier_limits.save",
  );
  expect(audits).toHaveLength(3);
  expect(audits[2]?.metadata.before).toMatchObject({ maxInstances: 7 });
});

it("refuses an unknown tier, a bad market and limits that do not parse", async () => {
  for (const bad of [
    { market: "BD", tier: "vip", limits },
    { market: "bd", tier: "new", limits },
    { market: "BD", tier: "new", limits: { ...limits, maxInstances: 0 } },
    { market: "BD", tier: "new", limits: { ...limits, maxBundleUsd: "1e9" } },
  ]) {
    expect(await as((r) => r.tierLimits.save(bad as never, "r"))).toEqual({
      ok: false,
      error: "validation",
    });
  }
});

it("only superadmin and ops read and write; finance and support are refused", async () => {
  for (const role of ["finance", "support"] as const) {
    const other: AdminActor = {
      adminId: await newAdmin(t.pool, role),
      role,
      ip: "203.0.113.9",
      userAgent: "test",
    };
    expect(await as((r) => r.tierLimits.read("BD"), other)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      await as((r) => r.tierLimits.save({ market: "BD", tier: "new", limits }, "r"), other),
    ).toEqual({ ok: false, error: "forbidden" });
  }
});

it("a stored row that does not parse reads as invalid, shows in the admin read, and a save replaces it", async () => {
  await t.pool.query(`update settings set value = '{"v":1}'::jsonb where key = 'tier_limits'`);
  expect(await readAs("new")).toEqual({ state: "invalid" });
  const read = await as((r) => r.tierLimits.read("BD"));
  expect(read.ok && read.value.rows.find((x) => x.tier === "new")?.state).toBe("invalid");
  expect(
    await as((r) => r.tierLimits.save({ market: "BD", tier: "new", limits }, "fix")),
  ).toMatchObject({ ok: true, replayed: false });
});
