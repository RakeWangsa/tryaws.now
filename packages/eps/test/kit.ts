import { randomBytes } from "node:crypto";
import { beforeAll } from "vitest";
import { ensureSystemAccounts, openWallet, type Clock } from "@tc/core";
import type { Tx } from "@tc/db";
import {
  attachErrorListeners,
  newCustomer,
  runTransaction,
  useTempDatabase,
  type DatabaseRole,
} from "@tc/db/testing";
import type { EpsDeps, PaymentAlert } from "../deps";
import { InMemoryEps } from "../fake";
import { startTopUp } from "../topup";

export const PLANTED_SECRET = "planted-secret-hash-key-0123456789";

export class FakeClock implements Clock {
  constructor(private current = new Date("2030-01-01T00:00:00Z")) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = d;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface AlertEvent {
  kind: string;
  paymentId: string;
  reason: string;
  expectedMinor: bigint;
  gotMinor: bigint | null;
}

export interface LogLine {
  event: string;
  fields: Record<string, string | number | boolean>;
}

export interface EpsKit {
  readonly pool: ReturnType<typeof useTempDatabase>["pool"];
  readonly databaseName: string;
  readonly eps: InMemoryEps;
  readonly clock: FakeClock;
  readonly alerts: AlertEvent[];
  readonly logs: LogLine[];
  /** The deps as `role` (web_rw by default). The gateway is the shared InMemoryEps unless replaced. */
  deps(role?: DatabaseRole, over?: Partial<EpsDeps>): EpsDeps;
  /** A customer with an open wallet. */
  newCustomer(): Promise<string>;
  /** Runs fn as the owner role of the temporary database (reads for assertions). */
  run<T>(fn: (tx: Tx) => Promise<T>, role?: DatabaseRole): Promise<T>;
  balance(customerId: string): Promise<bigint>;
  ledgerRows(key: string): Promise<number>;
  payment(paymentId: string): Promise<{
    status: string;
    amount: bigint;
    customerId: string;
    merchantTransactionId: string;
    gatewayTransactionId: string | null;
    ledgerTransactionId: string | null;
    verifyPayload: unknown;
  }>;
  discrepancies(): Promise<Array<{ details: Record<string, unknown> }>>;
  reset(): void;
}

/** One temporary database for the test file, with the platform accounts of BDT and an in-memory EPS. */
export function useEpsKit(): EpsKit {
  const t = useTempDatabase();
  beforeAll(async () => {
    attachErrorListeners(t.pool);
    await runTransaction(t.db, (tx) => ensureSystemAccounts(tx));
  });
  const eps = new InMemoryEps();
  const clock = new FakeClock();
  const alerts: AlertEvent[] = [];
  const logs: LogLine[] = [];
  const alert: PaymentAlert = {
    async raise(event) {
      alerts.push(event);
    },
  };
  const kit: EpsKit = {
    get pool() {
      return t.pool;
    },
    get databaseName() {
      return t.name;
    },
    eps,
    clock,
    alerts,
    logs,
    deps(role = "web_rw", over = {}) {
      return {
        gateway: eps,
        clock,
        run: (fn) => runTransaction(t.db, fn, { role }),
        newPaymentId: () => crypto.randomUUID(),
        randomBytes: (n) => new Uint8Array(randomBytes(n)),
        limitKey: "test-limit-key-not-a-secret",
        urls: {
          successUrl: "https://example.test/pay/eps/success",
          failUrl: "https://example.test/pay/eps/fail",
          cancelUrl: "https://example.test/pay/eps/cancel",
        },
        alert,
        log: (event, fields) => {
          logs.push({ event, fields });
        },
        ...over,
      };
    },
    async newCustomer() {
      const customerId = await newCustomer(t.pool);
      const opened = await runTransaction(t.db, (tx) => openWallet(tx, customerId), {
        role: "web_rw",
      });
      if (!opened.ok) throw new Error(`openWallet failed: ${opened.error}`);
      return customerId;
    },
    run: (fn, role) => runTransaction(t.db, fn, role === undefined ? {} : { role }),
    async balance(customerId) {
      const r = await t.pool.query<{ b: string }>(
        "select balance_minor::text as b from wallets where customer_id = $1",
        [customerId],
      );
      return BigInt(r.rows[0]?.b ?? "0");
    },
    async ledgerRows(key) {
      const r = await t.pool.query<{ n: number }>(
        "select count(*)::int as n from ledger_transactions where idempotency_key = $1",
        [key],
      );
      return r.rows[0]?.n ?? 0;
    },
    async payment(paymentId) {
      const r = await t.pool.query(
        `select status, amount_minor::text as amount, customer_id, merchant_transaction_id,
                gateway_transaction_id, ledger_transaction_id, verify_payload
           from payments where id = $1`,
        [paymentId],
      );
      const row = r.rows[0];
      if (row === undefined) throw new Error("no such payment");
      return {
        status: row.status as string,
        amount: BigInt(row.amount as string),
        customerId: row.customer_id as string,
        merchantTransactionId: row.merchant_transaction_id as string,
        gatewayTransactionId: row.gateway_transaction_id as string | null,
        ledgerTransactionId: row.ledger_transaction_id as string | null,
        verifyPayload: row.verify_payload as unknown,
      };
    },
    async discrepancies() {
      const r = await t.pool.query("select details from discrepancies where kind = 'payment'");
      return r.rows as Array<{ details: Record<string, unknown> }>;
    },
    // Clears what a test reads (calls, alerts, logs). The fake's counter of EPS ids is NOT reset: ids
    // stay unique in the file's database, as the duplicate-id check of verify needs (R6).
    reset() {
      eps.initialized.length = 0;
      eps.verifyCalls.length = 0;
      alerts.length = 0;
      logs.length = 0;
    },
  };
  return kit;
}

let ipCounter = 0;
/** A client address no other test of the process used, so the per-IP limits of one test never reach another. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface Started {
  customerId: string;
  paymentId: string;
  merchantTransactionId: string;
}

/** A customer with a wallet and a top-up that EPS accepted (status redirected). */
export async function startPayment(kit: EpsKit, amountMinor = 150000n): Promise<Started> {
  const customerId = await kit.newCustomer();
  const r = await startTopUp(
    kit.deps(),
    { customerId },
    { amountMinor, idempotencyKey: "key-" + crypto.randomUUID() },
    { clientIp: freshIp() },
  );
  if (!r.ok) throw new Error(`startTopUp failed: ${r.error}`);
  const p = await kit.payment(r.value.paymentId);
  return {
    customerId,
    paymentId: r.value.paymentId,
    merchantTransactionId: p.merchantTransactionId,
  };
}
