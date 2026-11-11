import { beforeAll } from "vitest";
import type { Database, Tx } from "@tc/db";
import {
  attachErrorListeners,
  createTempDatabase,
  newCustomer,
  runTransaction,
  useTempDatabase,
  type DatabaseRole,
  type Queryable,
  type TempDatabaseHandle,
} from "@tc/db/testing";
import { ensureSystemAccounts, openWallet } from "../ledger/accounts";
import { postTransaction } from "../ledger/post";
import type { PostTransactionInput } from "../ledger/types";
import type { Result } from "../types";

interface Source {
  readonly pool: TempDatabaseHandle["pool"]; // a pg.Pool: inTransaction and the pool size need it
  readonly db: Database;
}

export interface Wallet {
  customerId: string;
  walletId: string;
  accountId: string;
}

export interface LedgerKit {
  /** The pool of the owner: it reads, and it corrupts what the roles cannot. */
  readonly pool: Queryable;
  readonly db: Database;
  /** One transaction as the owner, or as `role` (the grants of migration 0006 then apply). */
  run<T>(fn: (tx: Tx) => Promise<T>, role?: DatabaseRole): Promise<T>;
  /** A customer, a wallet row and a customer_wallet account, made as web_rw by openWallet. */
  newWallet(over?: { currency?: string }): Promise<Wallet>;
  /** A verified top-up by the system (as worker_rw); returns the ledger transaction id. */
  fund(wallet: Wallet, amountMinor: bigint): Promise<string>;
  counts(): Promise<{ transactions: number; entries: number }>;
  cache(customerId: string): Promise<{ balance: bigint; version: number }>;
  /** The id of a platform ledger account (customer_id is null) of the currency (default BDT). */
  platformAccount(type: string, currency?: string): Promise<string>;
  /** Runs `body` in a transaction as `role` and keeps it open until release(); `reached` resolves when `body` is done (also when it threw: `result` then rejects). */
  holdOpen<T>(
    body: (tx: Tx) => Promise<T>,
    role?: DatabaseRole,
  ): { result: Promise<T>; reached: Promise<void>; release(): void };
  /** Resolves when a backend of this database waits for a lock; rejects after timeoutMs. */
  waitForLockWaiter(timeoutMs?: number): Promise<void>;
  /** The largest number of connections the pool of the database opens. */
  poolSize(): number;
}

const hex32 = () => crypto.randomUUID().replaceAll("-", "");

/** Valid posting requests, in the shapes of spec 9.1. */
export const inputs = {
  topup(
    customerId: string,
    amountMinor: bigint,
    paymentId = crypto.randomUUID(),
  ): PostTransactionInput {
    return {
      kind: "topup",
      reference: { type: "payment", id: paymentId },
      idempotencyKey: `topup:${paymentId}`,
      actor: { type: "system" },
      postings: [
        { account: { type: "gateway_clearing" }, direction: "debit", amountMinor },
        { account: { type: "customer_wallet", customerId }, direction: "credit", amountMinor },
      ],
    };
  },
  /** The purchase of section 8: 5 USD at FX 127, 74295 paisa in four credit lines. */
  purchase(customerId: string, key = `order:${hex32()}`): PostTransactionInput {
    return {
      kind: "purchase",
      reference: { type: "order", id: crypto.randomUUID() },
      idempotencyKey: key,
      actor: { type: "customer", id: customerId },
      postings: [
        {
          account: { type: "customer_wallet", customerId },
          direction: "debit",
          amountMinor: 74295n,
        },
        { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: 63500n },
        { account: { type: "vat_korea_payable" }, direction: "credit", amountMinor: 6350n },
        { account: { type: "vat_bd_payable" }, direction: "credit", amountMinor: 3175n },
        { account: { type: "processing_fee_income" }, direction: "credit", amountMinor: 1270n },
      ],
    };
  },
  /** A purchase with one credit line, for any amount. */
  spend(customerId: string, amountMinor: bigint, key = `order:${hex32()}`): PostTransactionInput {
    return {
      kind: "purchase",
      reference: { type: "order", id: crypto.randomUUID() },
      idempotencyKey: key,
      actor: { type: "customer", id: customerId },
      postings: [
        { account: { type: "customer_wallet", customerId }, direction: "debit", amountMinor },
        { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor },
      ],
    };
  },
};

export function transactionIdOf(result: Result<{ transactionId: string }>): string {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value.transactionId;
}

function makeKit(source: Source): LedgerKit {
  const run: LedgerKit["run"] = (fn, role) =>
    runTransaction(source.db, fn, role === undefined ? {} : { role });
  const kit: LedgerKit = {
    get pool() {
      return source.pool;
    },
    get db() {
      return source.db;
    },
    run,
    async newWallet(over = {}) {
      let market: string | undefined;
      if (over.currency !== undefined && over.currency !== "BDT") {
        market = "US";
        await source.pool.query(
          `insert into markets (id, code, currency, gateway, locales, numerals, topup_min_minor, topup_max_minor)
           values (gen_random_uuid(), 'US', $1, 'eps', '{bn,en}', 'beng', 10000, 5000000) on conflict (code) do nothing`,
          [over.currency],
        );
      }
      const customerId = await newCustomer(source.pool, market === undefined ? {} : { market });
      const opened = await run((tx) => openWallet(tx, customerId), "web_rw");
      if (!opened.ok) throw new Error(`openWallet failed: ${opened.error}`);
      return { customerId, walletId: opened.value.walletId, accountId: opened.value.accountId };
    },
    async fund(wallet, amountMinor) {
      return transactionIdOf(
        await run(
          (tx) => postTransaction(tx, inputs.topup(wallet.customerId, amountMinor)),
          "worker_rw",
        ),
      );
    },
    async platformAccount(type, currency = "BDT") {
      const r = await source.pool.query<{ id: string }>(
        "select id from ledger_accounts where type = $1 and currency = $2 and customer_id is null",
        [type, currency],
      );
      if (r.rows[0] === undefined) throw new Error(`no platform account ${type} ${currency}`);
      return r.rows[0].id;
    },
    holdOpen(body, role) {
      let open!: () => void;
      const hold = new Promise<void>((resolve) => (open = resolve));
      let reach!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      const result = run(async (tx) => {
        try {
          const value = await body(tx);
          reach();
          await hold;
          return value;
        } catch (error) {
          reach(); // a failed set-up must not leave the test waiting
          throw error;
        }
      }, role);
      return { result, reached, release: open };
    },
    poolSize() {
      return source.pool.options.max ?? 10;
    },
    async counts() {
      const r = await source.pool.query<{ transactions: number; entries: number }>(
        `select (select count(*) from ledger_transactions)::int as transactions,
                (select count(*) from ledger_entries)::int as entries`,
      );
      return r.rows[0]!;
    },
    async cache(customerId) {
      const r = await source.pool.query<{ balance: string; version: number }>(
        "select balance_minor::text as balance, version from wallets where customer_id = $1",
        [customerId],
      );
      return { balance: BigInt(r.rows[0]!.balance), version: r.rows[0]!.version };
    },
    async waitForLockWaiter(timeoutMs = 5000) {
      const start = Date.now();
      for (;;) {
        const r = await source.pool.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
        );
        if (r.rows[0]!.n > 0) return;
        if (Date.now() - start > timeoutMs) throw new Error("no backend waits for a lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
  return kit;
}

/** One temporary database for the test file, with the platform accounts of BDT. */
export function useLedgerDatabase(): LedgerKit {
  const t = useTempDatabase();
  beforeAll(async () => {
    attachErrorListeners(t.pool);
    await runTransaction(t.db, (tx) => ensureSystemAccounts(tx));
  });
  return makeKit(t);
}

/** A database of its own for one case, with the platform accounts; the case drops it. */
export async function freshLedgerKit(): Promise<LedgerKit & { drop(): Promise<void> }> {
  const temp = await createTempDatabase();
  attachErrorListeners(temp.pool);
  try {
    await runTransaction(temp.db, (tx) => ensureSystemAccounts(tx));
  } catch (error) {
    // the caller has no kit to drop yet: drop the database here, or it stays on the shared server
    await temp.drop().catch(() => undefined);
    throw error;
  }
  return Object.assign(makeKit(temp), { drop: () => temp.drop() });
}
