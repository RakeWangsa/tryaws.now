// The shared fixture of the order tests (WP4-T4 Tasks 5 to 8): a customer with a funded wallet, a pool
// account with room, a catalog product, the staging rate and rule and the family flag on.
// It lives in this folder, not in packages/core/orders, because it imports @tc/db/testing and only
// test files and test folders may (tests/repo/testing-entry.test.mjs).
import { seedLaunchData, type Tx } from "@tc/db";
import {
  insertRow,
  newCustomer,
  runTransaction,
  seedPool,
  uniqueSuffix,
  type TempDatabaseHandle,
} from "@tc/db/testing";
import { ensureSystemAccounts, openWallet } from "../ledger/accounts";
import { postTransaction } from "../ledger/post";
import { createManualClock } from "../operations/manual-clock";
import { createMemoryQueue, type MemoryQueue } from "../operations/queue";
import { createDraft, type OrdersDeps } from "../orders/draft";
import { childId } from "../orders/ids";
import { makeOrders } from "../orders/place";
import type { OrderDraft, OrderSession } from "../orders/types";
import type { Clock, Result } from "../types";
import { cells, P1, REGION } from "./capacity-helpers";
import { inputs } from "./ledger-fixtures";

/** The instant the staging rate and rule take effect; every kit starts its clock here. */
export const START = new Date("2026-11-11T06:00:00.000Z");
/** The 5 USD plan at the staging rate 127, priced by the staging rule: 74295 paisa. */
export const PLAN_TOTAL = 74295n;
export const FAMILY = "linux_instance";
export { REGION };

export interface KitOptions {
  /** The wallet balance after the top-up. Default 10 000 000 paisa. */
  readonly balanceMinor?: bigint;
  readonly kycStatus?: string;
  readonly riskTier?: "new" | "trusted";
  readonly status?: string;
  /** The vCPU and static IP limits of the pool cell. Default 40 and 50. */
  readonly vcpuLimit?: number;
  readonly ipLimit?: number;
  /** The state of the family flag. Default on. */
  readonly flag?: "on" | "off" | "missing";
  readonly awsPriceUsd?: string;
  readonly productActive?: boolean;
}

export interface Buyer {
  readonly customerId: string;
  readonly session: OrderSession;
}

export interface Kit extends Buyer {
  readonly t: TempDatabaseHandle;
  readonly clock: Clock & { advance(seconds: number): void; set(at: Date): void };
  readonly secrets: readonly Uint8Array[];
  readonly queue: MemoryQueue;
  readonly deps: OrdersDeps;
  readonly productId: string;
  readonly poolAccountId: string;
  /** One transaction as web_rw, like the production wiring. */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** One transaction as the table owner: fixtures that no application role may write. */
  owner<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The config of an instance order; `over` replaces fields. */
  config(over?: Record<string, unknown>): Record<string, unknown>;
  /** The input of createOrderDraft for that config. */
  input(over?: Record<string, unknown>): { family: string; config: Record<string, unknown> };
  /** A valid draft for a buyer (the kit's own by default); throws when it is refused. */
  draft(over?: Record<string, unknown>, buyer?: Buyer): Promise<OrderDraft>;
  /** Another customer with a funded wallet and a row in the state given. */
  newBuyer(
    options?: Pick<KitOptions, "balanceMinor" | "kycStatus" | "riskTier" | "status">,
  ): Promise<Buyer>;
  /** Updates columns of the customers row as the owner (the session is not touched). */
  setCustomer(customerId: string, columns: Record<string, string>): Promise<void>;
  setFlag(state: "on" | "off" | "missing"): Promise<void>;
  /** Inserts a rate that is in force a minute after START and moves the clock just past it (inside the 30 minutes of a draft). */
  changeFxRate(rate: string): Promise<void>;
  /**
   * WPU-Y1. A rate older than 7 days prices nothing. Call this after the clock moved more than 6 days past the
   * last rate: it inserts the rate that is in force again, taking effect at the clock (an admin's re-confirm).
   */
  refreshFx(): Promise<void>;
  newProduct(over?: Record<string, unknown>): Promise<string>;
  balance(customerId?: string): Promise<bigint>;
  /** `<region>/<quota code>` to `used` for the kit's pool account. */
  used(): Promise<Record<string, number>>;
}

let rateCounter = 0;

function unwrap<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`orders kit: ${what} was refused (${result.error})`);
  return result.value;
}

/** A 32-byte key for the draft token; `makeKit` uses the first and the second is "another signer". */
export const SECRET_A = new Uint8Array(32).fill(7);
export const SECRET_B = new Uint8Array(32).fill(9);

export async function makeKit(t: TempDatabaseHandle, options: KitOptions = {}): Promise<Kit> {
  const clock = createManualClock(START);
  const queue = createMemoryQueue({ clock });
  const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runTransaction(t.db, fn, { role: "web_rw" });
  const owner = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => runTransaction(t.db, fn);

  await owner(async (tx) => {
    await ensureSystemAccounts(tx);
    await seedLaunchData(tx, { environment: "staging", at: START });
  });

  const setFlag = async (state: "on" | "off" | "missing"): Promise<void> => {
    if (state === "missing") {
      await t.pool.query("delete from feature_flags where key = $1 and market = 'BD'", [FAMILY]);
      return;
    }
    await t.pool.query(
      `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), $1, 'BD', $2)
       on conflict (key, market) do update set enabled = excluded.enabled`,
      [FAMILY, state === "on"],
    );
  };
  await setFlag(options.flag ?? "on");

  const newBuyer: Kit["newBuyer"] = async (over = {}) => {
    const customerId = await newCustomer(t.pool, {
      kyc_status: over.kycStatus ?? "verified",
      risk_tier: over.riskTier ?? "new",
      status: over.status ?? "active",
    });
    unwrap(await run((tx) => openWallet(tx, customerId)), "openWallet");
    const amount = over.balanceMinor ?? 10_000_000n;
    if (amount > 0n) {
      unwrap(
        await runTransaction(t.db, (tx) => postTransaction(tx, inputs.topup(customerId, amount)), {
          role: "worker_rw",
        }),
        "the top-up",
      );
    }
    return {
      customerId,
      session: { customerId, kycStatus: "verified", riskTier: "new", locale: "en" },
    };
  };
  const buyer = await newBuyer(options);

  // One pool account for the whole file: earlier cases left orders and subscriptions that point at
  // their resources, so the rows cannot be deleted. The cell limits and the tier are reset.
  const tier = options.riskTier ?? "new";
  const vcpuLimit = options.vcpuLimit ?? 40;
  const ipLimit = options.ipLimit ?? 50;
  const found = await t.pool.query<{ id: string }>(
    "select id from pool_accounts order by id limit 1",
  );
  let poolAccountId = found.rows[0]?.id;
  if (poolAccountId === undefined) {
    poolAccountId = (
      await seedPool(t.pool, { id: P1, tier, cells: cells(vcpuLimit, 0, ipLimit, 0) })
    ).poolAccountId;
  } else {
    await t.pool.query("update pool_accounts set tier = $2, status = 'active' where id = $1", [
      poolAccountId,
      tier,
    ]);
    await t.pool.query(
      `update pool_capacity set used = 0,
              quota_limit = case quota_code when 'instance_vcpu' then $2::int else $3::int end
        where pool_account_id = $1 and region = $4`,
      [poolAccountId, vcpuLimit, ipLimit, REGION],
    );
  }
  const poolId = poolAccountId;

  const newProduct: Kit["newProduct"] = (over = {}) =>
    insertRow(t.pool, "catalog_products", {
      family: FAMILY,
      aws_id: "kit-" + uniqueSuffix(),
      platform: "linux",
      region: REGION,
      specs: JSON.stringify({ vcpus: 2, ramGb: "1", power: 1000 }),
      aws_price_usd: options.awsPriceUsd ?? "5",
      billing_unit: "month",
      feature_flag: FAMILY,
      active: options.productActive ?? true,
      synced_at: START.toISOString(),
      ...over,
    });
  const productId = await newProduct();

  const secrets = [SECRET_A];
  const deps: OrdersDeps = { run, clock, secrets, queue };
  const config: Kit["config"] = (over = {}) => ({
    productId,
    region: REGION,
    displayName: "web-" + uniqueSuffix(),
    ...over,
  });
  const input: Kit["input"] = (over = {}) => ({ family: FAMILY, config: config(over) });

  return {
    ...buyer,
    t,
    clock,
    secrets,
    queue,
    deps,
    productId,
    poolAccountId: poolId,
    run,
    owner,
    config,
    input,
    newBuyer,
    newProduct,
    setFlag,
    async draft(over = {}, who = buyer) {
      return unwrap(await createDraft(deps, who.session, input(over)), "createOrderDraft");
    },
    async setCustomer(customerId, columns) {
      for (const [column, value] of Object.entries(columns)) {
        if (!["kyc_status", "risk_tier", "status"].includes(column)) {
          throw new Error("orders kit: not a column the kit changes");
        }
        await t.pool.query(`update customers set ${column} = $2 where id = $1`, [
          customerId,
          value,
        ]);
      }
    },
    async changeFxRate(rate) {
      rateCounter += 1;
      const effective = new Date(START.getTime() + 60_000 + rateCounter * 1000);
      await insertRow(t.pool, "fx_rates", {
        market: "BD",
        rate,
        effective_from: effective.toISOString(),
      });
      clock.set(new Date(effective.getTime() + 1000));
    },
    async refreshFx() {
      const now = clock.now();
      await t.pool.query(
        `insert into fx_rates (id, market, rate, effective_from)
         select gen_random_uuid(), market, rate, $1 from fx_rates
         where market = 'BD' and effective_from <= $1 order by effective_from desc limit 1
         on conflict (market, effective_from) do nothing`,
        [now.toISOString()],
      );
    },
    async balance(customerId = buyer.customerId) {
      const r = await t.pool.query<{ b: string }>(
        "select balance_minor::text as b from wallets where customer_id = $1",
        [customerId],
      );
      return BigInt(r.rows[0]?.b ?? "-1");
    },
    async used() {
      const r = await t.pool.query<{ region: string; quota_code: string; used: number }>(
        "select region, quota_code, used from pool_capacity where pool_account_id = $1",
        [poolId],
      );
      return Object.fromEntries(r.rows.map((x) => [`${x.region}/${x.quota_code}`, x.used]));
    },
  };
}

const SNAPSHOT_TABLES = [
  "resources",
  "orders",
  "subscriptions",
  "operations",
  "ledger_transactions",
  "ledger_entries",
  "wallets",
  "pool_capacity",
  "customer_homes",
  "audit_log",
] as const;

/**
 * `SELECT *` of ten tables as the text of each row, sorted by id, read as the owner: the full rows
 * the backlog asks for, not counts. The table names are the constants above (R11).
 */
export async function snapshotRows(
  t: TempDatabaseHandle,
): Promise<Record<(typeof SNAPSHOT_TABLES)[number], string[]>> {
  const out = {} as Record<(typeof SNAPSHOT_TABLES)[number], string[]>;
  for (const table of SNAPSHOT_TABLES) {
    const r = await t.pool.query<{ row: string }>(
      `select to_jsonb(x)::text as row from ${table} x order by x.id`,
    );
    out[table] = r.rows.map((x) => x.row);
  }
  return out;
}

/** Counts rows of tables of one customer or of the whole database, for the proofs of single rows. */
export async function countRows(
  t: TempDatabaseHandle,
  table: (typeof SNAPSHOT_TABLES)[number],
): Promise<number> {
  const r = await t.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return r.rows[0]?.n ?? 0;
}

/** A paid order of the buyer (the kit's own by default), made through placeOrder. */
export async function placeOne(
  kit: Kit,
  buyer: Buyer = kit,
): Promise<{ orderId: string; resourceId: string; token: string; clientKey: string }> {
  const { token } = await kit.draft({}, buyer);
  const clientKey = "k" + crypto.randomUUID().replaceAll("-", "");
  const placed = unwrap(
    await makeOrders(kit.deps).placeOrder(buyer.session, { token, idempotencyKey: clientKey }),
    "placeOrder",
  );
  return {
    orderId: placed.orderId,
    resourceId: childId(placed.orderId, "resource"),
    token,
    clientKey,
  };
}
