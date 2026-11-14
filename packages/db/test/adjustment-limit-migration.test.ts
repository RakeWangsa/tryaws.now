import { readFileSync } from "node:fs";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../migrate";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { ADJUSTMENT_LIMIT_KEY } from "../repositories/admin/wallets";
import { ADJUSTMENT_LIMIT_SEED, seedLaunchData } from "../seed/launch";
import { runTransaction } from "../tx";
import { fundedWallet, testPoster, walletOf } from "./admin-money-support";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-X5 (owner decision 2026-11-14): migration 0029 gives market BD the single-admin adjustment limit of
// 10,000 BDT = 1,000,000 paisa per wallet per 24 hours, with one system audit row, only where no row exists;
// the launch seed adds the same for a market created after the migrations. The tests of one file share one
// database and run in order.
const t = useTempDatabase();
const TAG = "0029_wallet_adjustment_limit_bd";
const SQL = readFileSync(`${MIGRATIONS_FOLDER}/${TAG}.sql`, "utf8");
const TARGET = `BD:${ADJUSTMENT_LIMIT_KEY}`;
const REASON = "owner decision 2026-11-14: single-admin adjustment limit 10,000 BDT";

const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "finance"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const credit = (customerId: string, amountMinor: bigint, over: Record<string, unknown> = {}) => ({
  requestId: uuidv7(),
  at: new Date(),
  customerId,
  direction: "credit" as const,
  amountMinor,
  kind: "deposit" as const,
  ...over,
});

const limitRows = async () =>
  (
    await t.pool.query<{ value: unknown; scope_id: string | null; set_by: string | null }>(
      "select value, scope_id, set_by from settings where key = $1 and market = 'BD' and scope = 'market'",
      [ADJUSTMENT_LIMIT_KEY],
    )
  ).rows;
const auditRows = async () =>
  (
    await t.pool.query(
      `select actor_type, actor_id, action, target_type, target_id, ip, user_agent, metadata
         from audit_log where target_type = 'setting' and target_id = $1 order by created_at, id`,
      [TARGET],
    )
  ).rows;

describe("migration 0029: the single-admin adjustment limit of market BD", () => {
  it("is the journal entry right after 0028, with a newer time", () => {
    const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at - 1]?.tag).toBe("0028_disk_max_gb_16000");
    expect(journal.entries[at]!.when).toBeGreaterThan(journal.entries[at - 1]!.when);
    expect(journal.entries[at]!.idx).toBe(journal.entries[at - 1]!.idx + 1);
  });

  it("writes nothing on a fresh database where the market does not exist yet", async () => {
    // useTempDatabase applied every migration, 0029 included, before any market row existed.
    expect(await limitRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("with market BD present inserts 1,000,000 paisa and exactly one system audit row; a second run changes nothing", async () => {
    await ensureMarket(t.pool);
    await t.pool.query(SQL);
    await t.pool.query(SQL);
    expect(await limitRows()).toEqual([{ value: "1000000", scope_id: null, set_by: null }]);
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "system",
      actor_id: null,
      action: "setting.set",
      target_type: "setting",
      target_id: TARGET,
      ip: null,
      user_agent: null,
    });
    expect(audit[0]?.metadata).toMatchObject({
      reason: REASON,
      before: null,
      after: { value: "1000000" },
    });
  });

  it("the wallet detail reads the limit as 1,000,000n", async () => {
    const w = await fundedWallet(t.pool, 0n);
    const out = await asAdmin(await actorOf(), (r) => r.wallets.detail(w.customerId));
    expect(out.ok && out.value.limitMinor).toBe(1_000_000n);
  });

  it("one finance admin posts 10,000 BDT at once; anything more in 24 hours waits for a second admin", async () => {
    const a = await actorOf("finance");
    const w = await fundedWallet(t.pool, 0n);
    const first = credit(w.customerId, 1_000_000n);
    expect(
      await asAdmin(a, (r) => r.wallets.createAdjustment(first, "bank deposit slip 1", testPoster)),
    ).toMatchObject({ ok: true, replayed: false, value: { status: "approved" } });
    expect(await walletOf(t.pool, w.customerId)).toEqual({
      balance: 1_000_000n,
      entriesSum: 1_000_000n,
    });
    // The 24-hour sum of the wallet counts: one paisa more waits.
    const second = credit(w.customerId, 1n);
    expect(
      await asAdmin(a, (r) =>
        r.wallets.createAdjustment(second, "bank deposit slip 2", testPoster),
      ),
    ).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(await walletOf(t.pool, w.customerId)).toEqual({
      balance: 1_000_000n,
      entriesSum: 1_000_000n,
    });
  });

  // Only finance creates an adjustment (CREATE_ROLES of wallets.ts); a superadmin may only decide one.
  it("10,000.01 BDT in one request waits; a debit of 10,000 BDT posts at once; a superadmin may not create", async () => {
    const a = await actorOf("finance");
    const w = await fundedWallet(t.pool, 2_000_000n);
    const over = credit(w.customerId, 1_000_001n);
    expect(
      await asAdmin(a, (r) => r.wallets.createAdjustment(over, "large deposit", testPoster)),
    ).toMatchObject({ ok: true, value: { status: "pending" } });
    const debit = credit(w.customerId, 1_000_000n, { direction: "debit", kind: "correction" });
    expect(
      await asAdmin(a, (r) =>
        r.wallets.createAdjustment(debit, "double top-up removed", testPoster),
      ),
    ).toMatchObject({ ok: true, value: { status: "approved" } });
    const bySuper = credit(w.customerId, 1n);
    expect(
      await asAdmin(await actorOf("superadmin"), (r) =>
        r.wallets.createAdjustment(bySuper, "one paisa", testPoster),
      ),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await walletOf(t.pool, w.customerId)).toEqual({
      balance: 1_000_000n,
      entriesSum: 1_000_000n,
    });
  });

  it("a value set later is never overwritten, and no audit row is added", async () => {
    await t.pool.query(
      `update settings set value = '"500000"'::jsonb where key = $1 and market = 'BD' and scope = 'market'`,
      [ADJUSTMENT_LIMIT_KEY],
    );
    await t.pool.query(SQL);
    expect(await limitRows()).toEqual([{ value: "500000", scope_id: null, set_by: null }]);
    expect(await auditRows()).toHaveLength(1);
  });

  it("the launch seed adds the same row and audit row where the migration found no market, once", async () => {
    await t.pool.query("delete from settings where key = $1", [ADJUSTMENT_LIMIT_KEY]);
    const seed = () =>
      runTransaction(t.db, (tx) =>
        seedLaunchData(tx, { environment: "staging", at: new Date("2026-11-14T06:00:00Z") }),
      );
    await seed();
    await seed();
    expect(ADJUSTMENT_LIMIT_SEED.key).toBe(ADJUSTMENT_LIMIT_KEY);
    expect(await limitRows()).toEqual([{ value: "1000000", scope_id: null, set_by: null }]);
    const audit = await auditRows();
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ actor_type: "system", actor_id: null, action: "setting.set" });
    expect(audit[1]?.metadata).toMatchObject({ reason: REASON, after: { value: "1000000" } });
  });
});
