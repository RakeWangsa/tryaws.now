import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";
import { ensureMarket, newAdmin } from "./fixtures";

const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
const actor = async (): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, "ops"),
  role: "ops",
  ip: "203.0.113.9",
  userAgent: "test",
});
const auditRows = (actorId: string) => auditRowsOf(t.pool, actorId);
const flag = async (key: string) =>
  (await t.pool.query("select enabled from feature_flags where key = $1 and market = 'BD'", [key]))
    .rows;

// Every write of adminRepos has a case here; the completeness test below fails when one is missing (R10).
const ADMIN_WRITE_CASES: Record<string, (r: AdminRepos) => Promise<unknown>> = {
  "featureFlags.set": (r) =>
    r.featureFlags.set(
      { key: "linux_instance", market: "BD", enabled: true },
      "launch of Linux servers",
    ),
  "fxRates.set": (r) =>
    r.fxRates.set(
      {
        market: "BD",
        rate: "127",
        effectiveFrom: new Date("2026-11-11T06:00:00.000Z"),
        at: new Date("2026-11-11T06:00:00.000Z"),
      },
      "first rate",
    ),
  "pricingRules.save": (r) =>
    r.pricingRules.save(
      {
        market: "BD",
        productFamily: null,
        effectiveFrom: new Date("2026-11-11T06:00:00.000Z"),
        at: new Date("2026-11-11T06:00:00.000Z"),
        steps: [
          {
            code: "markup",
            rate: "0",
            base: "aws",
            label: { bn: "সার্ভিস চার্জ", en: "Service charge" },
          },
        ],
      },
      "first rule",
    ),
  "waitlist.notifyNext": (r) =>
    r.waitlist.notifyNext(
      { productFamily: "linux_instance", region: "ap-southeast-1", reason: "capacity", count: 1 },
      "one unit freed",
    ),
};
// Admin reads ("<repo>.<method>") that write no audit row. Empty until WP8 decides where admin reads live and whether a read is audited (open point 21).
const ADMIN_READ_METHODS: readonly string[] = ["waitlist.list"];

it("every method of adminRepos is a listed read or a write with an audit case", () => {
  const repos = adminRepos({} as Tx, { adminId: uuidv7(), role: "ops", ip: "203.0.113.9" });
  const methods = Object.entries(repos)
    .flatMap(([n, r]) => Object.keys(r).map((m) => `${n}.${m}`))
    .sort();
  expect([...Object.keys(ADMIN_WRITE_CASES), ...ADMIN_READ_METHODS].sort()).toEqual(methods);
});

it.each(Object.entries(ADMIN_WRITE_CASES))(
  "%s writes one audit row with actor, reason, IP and target (R10)",
  async (_, run) => {
    await ensureMarket(t.pool);
    const a = await actor();
    await asAdmin(a, run);
    const rows = await auditRows(a.adminId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ actor_type: "admin", ip: "203.0.113.9", user_agent: "test" });
    expect(row?.target_type).toBeTruthy();
    expect(row?.target_id).toBeTruthy();
    expect(row?.metadata.reason).toBeTruthy();
  },
);

it("featureFlags.set stores the flag and the change; the same value again is a replay with its own audit row", async () => {
  await ensureMarket(t.pool);
  const a = await actor();
  expect(
    await asAdmin(a, (r) =>
      r.featureFlags.set({ key: "bucket", market: "BD", enabled: true }, "beta"),
    ),
  ).toEqual({ ok: true, replayed: false, value: { key: "bucket", market: "BD", enabled: true } });
  expect(
    await asAdmin(a, (r) =>
      r.featureFlags.set({ key: "bucket", market: "BD", enabled: true }, "beta again"),
    ),
  ).toMatchObject({ ok: true, replayed: true });
  expect(await flag("bucket")).toEqual([{ enabled: true }]);
  expect((await auditRows(a.adminId)).map((r) => [r.action, r.target_id, r.metadata])).toEqual([
    ["feature_flag.set", "BD:bucket", { reason: "beta", before: null, after: { enabled: true } }],
    [
      "feature_flag.set",
      "BD:bucket",
      { reason: "beta again", before: { enabled: true }, after: { enabled: true } },
    ],
  ]);
});

it("a blank reason is a validation failure and nothing is written", async () => {
  await ensureMarket(t.pool);
  const a = await actor();
  expect(
    await asAdmin(a, (r) => r.featureFlags.set({ key: "cdn", market: "BD", enabled: true }, "   ")),
  ).toEqual({ ok: false, error: "validation" });
  expect(await flag("cdn")).toEqual([]);
  expect(await auditRows(a.adminId)).toEqual([]);
});

it("the write and its audit row commit or roll back together", async () => {
  await ensureMarket(t.pool);
  const a = { ...(await actor()), ip: "not-an-ip" };
  await expect(
    asAdmin(a, (r) => r.featureFlags.set({ key: "dns", market: "BD", enabled: true }, "x")),
  ).rejects.toMatchObject({ name: "DbError", code: "22P02" });
  expect(await flag("dns")).toEqual([]);
});

it("adminRepos refuses an incomplete actor before any query", () => {
  for (const bad of [
    { adminId: "x", role: "ops", ip: "203.0.113.9" },
    { adminId: uuidv7(), role: "ops", ip: "" },
  ] as AdminActor[]) {
    expect(() => adminRepos({} as Tx, bad)).toThrow(
      new TypeError("adminRepos: the admin actor is incomplete"),
    );
  }
});
