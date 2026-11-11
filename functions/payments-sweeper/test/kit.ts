// A small kit for the proof tests of the sweeper, modelled on packages/eps/test/kit.ts (not imported:
// tests of one package do not import another package's test files). Real PostgreSQL, real grants:
// the sweeper runs as worker_rw, the top-up starts as web_rw.
import { randomBytes } from "node:crypto";
import { beforeAll } from "vitest";
import { ensureSystemAccounts, openWallet, type Clock, type LogEvent } from "@tc/core";
import type { Tx } from "@tc/db";
import {
  attachErrorListeners,
  newCustomer,
  runTransaction,
  useTempDatabase,
  type DatabaseRole,
} from "@tc/db/testing";
import { createEps, InMemoryEps, type Eps } from "@tc/eps";
import { buildSweeperDeps, type SweeperEnv } from "../deps";
import type { SecretSource } from "../secrets";

export const PLANTED = {
  EpsMerchantId: "PLANTED-MERCHANT",
  EpsStoreId: "PLANTED-STORE",
  EpsUsername: "PLANTED-USER",
  EpsPassword: "PLANTED-PASSWORD",
  EpsHashKey: "PLANTED-HASHKEY",
} as const;

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export class FakeClock implements Clock {
  constructor(private current = new Date("2030-01-01T00:00:00Z")) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = d;
  }
}

export interface Started {
  customerId: string;
  paymentId: string;
  merchantTransactionId: string;
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function useSweeperKit() {
  const t = useTempDatabase();
  beforeAll(async () => {
    attachErrorListeners(t.pool);
    await runTransaction(t.db, (tx) => ensureSystemAccounts(tx));
  });

  const eps = new InMemoryEps();
  const clock = new FakeClock();
  const logs: LogEvent[] = [];
  const secrets: SecretSource = { get: (name) => PLANTED[name] };
  const urls = {
    successUrl: "https://example.test/pay/eps/success",
    failUrl: "https://example.test/pay/eps/fail",
    cancelUrl: "https://example.test/pay/eps/cancel",
  };

  const asRole =
    (role: DatabaseRole) =>
    <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
      runTransaction(t.db, fn, { role });

  /** The EPS services as web_rw: start a top-up, handle a browser return. */
  function web(): Eps {
    return createEps({
      gateway: eps,
      clock,
      run: asRole("web_rw"),
      newPaymentId: () => crypto.randomUUID(),
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      limitKey: "test-limit-key-not-a-secret",
      urls,
      alert: { raise: async () => {} },
      log: () => {},
    });
  }

  /**
   * The real handler built by buildSweeperDeps as `role` (worker_rw, like production), with the in-memory
   * EPS as the gateway. `runTx` can be wrapped by a test (kill simulation).
   */
  function sweeper(
    over: {
      role?: DatabaseRole;
      limit?: number;
      runTx?: SweeperEnv["runTx"];
      secrets?: SecretSource;
    } = {},
  ) {
    return buildSweeperDeps({
      config: { mode: "sandbox", baseUrl: "https://example.test", limit: over.limit ?? 25 },
      secrets: over.secrets ?? secrets,
      fetch: (async () => {
        throw new Error("the proof tests never use the network");
      }) as typeof fetch,
      clock,
      runTx: over.runTx ?? asRole(over.role ?? "worker_rw"),
      log: (e) => logs.push(e),
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      gateway: eps,
    });
  }

  async function activateMarket(): Promise<void> {
    await t.pool.query("update markets set active = true where code = 'BD'");
  }

  /** A customer, with a wallet unless `wallet` is false. */
  async function customer(wallet = true): Promise<string> {
    const customerId = await newCustomer(t.pool);
    await activateMarket();
    if (wallet) {
      const opened = await runTransaction(t.db, (tx) => openWallet(tx, customerId), {
        role: "web_rw",
      });
      if (!opened.ok) throw new Error(`openWallet failed: ${opened.error}`);
    }
    return customerId;
  }

  async function startPayment(amountMinor = 150000n, wallet = true): Promise<Started> {
    const customerId = await customer(wallet);
    const r = await web().startTopUp(
      { customerId },
      { amountMinor, idempotencyKey: "key-" + crypto.randomUUID() },
      { clientIp: freshIp() },
    );
    if (!r.ok) throw new Error(`startTopUp failed: ${r.error}`);
    const m = await t.pool.query<{ merchant_transaction_id: string }>(
      "select merchant_transaction_id from payments where id = $1",
      [r.value.paymentId],
    );
    return {
      customerId,
      paymentId: r.value.paymentId,
      merchantTransactionId: m.rows[0]?.merchant_transaction_id ?? "",
    };
  }

  /** Puts the fake clock `ms` after the payment was created (created_at is the database clock). */
  async function clockAfter(s: Started, ms: number): Promise<void> {
    const r = await t.pool.query<{ created_at: Date }>(
      "select created_at from payments where id = $1",
      [s.paymentId],
    );
    clock.set(new Date((r.rows[0]?.created_at.getTime() ?? 0) + ms));
  }

  /** Sets the fake clock to `now` and makes the payment `ms` old at that moment (owner role). */
  async function makeOld(s: Started, now: Date, ms: number): Promise<void> {
    clock.set(now);
    await t.pool.query("update payments set created_at = $2 where id = $1", [
      s.paymentId,
      new Date(now.getTime() - ms),
    ]);
  }

  /** Closes every other open payment of the file's database so a sweep sees only the test's own rows. */
  async function isolate(...keep: Started[]): Promise<void> {
    await t.pool.query(
      "update payments set status = 'cancelled' where status in ('initiated','redirected') and id <> all($1::uuid[])",
      [keep.map((s) => s.paymentId)],
    );
  }

  async function ledgerRows(key: string): Promise<number> {
    const r = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from ledger_transactions where idempotency_key = $1",
      [key],
    );
    return r.rows[0]?.n ?? 0;
  }

  async function ledgerEntries(key: string): Promise<number> {
    const r = await t.pool.query<{ n: number }>(
      `select count(*)::int as n from ledger_entries e
         join ledger_transactions x on x.id = e.transaction_id where x.idempotency_key = $1`,
      [key],
    );
    return r.rows[0]?.n ?? 0;
  }

  async function balance(customerId: string): Promise<bigint> {
    const r = await t.pool.query<{ b: string }>(
      "select balance_minor::text as b from wallets where customer_id = $1",
      [customerId],
    );
    return BigInt(r.rows[0]?.b ?? "0");
  }

  async function payment(paymentId: string): Promise<{ status: string; verifiedAt: Date | null }> {
    const r = await t.pool.query<{ status: string; verified_at: Date | null }>(
      "select status, verified_at from payments where id = $1",
      [paymentId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error("no such payment");
    return { status: row.status, verifiedAt: row.verified_at };
  }

  async function discrepancyCount(paymentId: string): Promise<number> {
    const r = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from discrepancies where kind = 'payment' and details->>'paymentId' = $1",
      [paymentId],
    );
    return r.rows[0]?.n ?? 0;
  }

  async function rateLimitRows(): Promise<number> {
    const r = await t.pool.query<{ n: number }>("select count(*)::int as n from rate_limits");
    return r.rows[0]?.n ?? 0;
  }

  /** Runs as the owner role of the temporary database (setup and assertions that no app role may do). */
  async function owner(sql: string, params: unknown[] = []): Promise<void> {
    await t.pool.query(sql, params);
  }

  return {
    get pool() {
      return t.pool;
    },
    eps,
    clock,
    logs,
    secrets,
    web,
    sweeper,
    customer,
    startPayment,
    clockAfter,
    makeOld,
    isolate,
    ledgerRows,
    ledgerEntries,
    balance,
    payment,
    discrepancyCount,
    rateLimitRows,
    owner,
    runAs: asRole,
    get db() {
      return t.db;
    },
  };
}

export type SweeperKit = ReturnType<typeof useSweeperKit>;
