import { sql, type SQL } from "drizzle-orm";
import { PAYMENT_STATUSES } from "../../schema/money";
import { DISCREPANCY_KINDS, DISCREPANCY_STATUSES } from "../../schema/service";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";
import type { LedgerPoster } from "./ledger-port";

// 16.12 /payments and the discrepancies queue. Reads: finance and superadmin (discrepancies: ops too).
// `finance` re-verifies and records manual refunds. A payment is never credited here (R6): `reverify`
// puts it back in the state the sweeper verifies with EPS, server to server. A refund is a ledger
// posting made by the poster the app passes (@tc/core, R5) under a key derived from the payment (R7).
// Every write goes through `audited` (R10); the role check is a second layer behind requireAdmin (R9).
const READ_ROLES: readonly AdminRole[] = ["finance", "superadmin"];
const FINANCE_ONLY: readonly AdminRole[] = ["finance"];
const QUEUE_ROLES: readonly AdminRole[] = ["ops", "finance", "superadmin"];

const MAX_QUERY = 100;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
const MAX_MINOR = 9223372036854775807n;
const MERCHANT_TRANSACTION_ID = /^[\x21-\x7e]{10,128}$/;
const WHOLE_NUMBER = /^(0|[1-9][0-9]{0,17})$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const PAYLOAD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
// "pending" is initiated and redirected (9.2).
export type PaymentFilter = PaymentStatus | "pending";

export interface PaymentSearchInput {
  // A payment id, a customer id or the exact merchant transaction id.
  q?: string;
  status?: PaymentFilter;
  limit?: number;
  after?: string;
}

export interface PaymentListRow {
  id: string;
  customerId: string;
  gateway: string;
  merchantTransactionId: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  createdAt: Date;
  verifiedAt: Date | null;
}

export interface PaymentSearchResult {
  rows: PaymentListRow[];
  nextAfter: string | null;
}

export interface DiscrepancyRow {
  id: string;
  kind: string;
  status: string;
  createdAt: Date;
  // Only the keys of a payment discrepancy that are safe to show (R14); null for the other kinds.
  paymentId: string | null;
  reason: string | null;
  expectedMinor: bigint | null;
  gotMinor: bigint | null;
}

export interface RefundLine {
  transactionId: string;
  amountMinor: bigint;
  createdAt: Date;
}

export interface PaymentAdminDetail extends PaymentListRow {
  gatewayTransactionId: string | null;
  ledgerTransactionId: string | null;
  // The flat values of the stored (already allow-listed) payload; nested values and long text are dropped.
  verifyPayload: Record<string, string | number | boolean | null> | null;
  refund: RefundLine | null;
  discrepancies: DiscrepancyRow[];
}

export interface ReverifyInput {
  paymentId: string;
}

export interface PaymentReverified {
  id: string;
  status: string;
}

export interface RefundInput {
  paymentId: string;
  amountMinor: bigint;
}

export interface RefundRecorded {
  paymentId: string;
  customerId: string;
  amountMinor: bigint;
  ledgerTransactionId: string;
}

export interface DiscrepancyListInput {
  kind?: (typeof DISCREPANCY_KINDS)[number];
  status?: (typeof DISCREPANCY_STATUSES)[number];
  limit?: number;
}

export interface DiscrepancyResolveInput {
  id: string;
}

export interface DiscrepancyResolved {
  id: string;
  status: string;
}

export interface PaymentsAdminRepo {
  search(input: PaymentSearchInput): Promise<Written<PaymentSearchResult>>;
  detail(paymentId: string): Promise<Written<PaymentAdminDetail>>;
  reverify(input: ReverifyInput, reason: string): Promise<Written<PaymentReverified>>;
  recordManualRefund(
    input: RefundInput,
    reason: string,
    post: LedgerPoster,
  ): Promise<Written<RefundRecorded>>;
  discrepancies(input?: DiscrepancyListInput): Promise<Written<DiscrepancyRow[]>>;
  resolveDiscrepancy(
    input: DiscrepancyResolveInput,
    reason: string,
  ): Promise<Written<DiscrepancyResolved>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: RepoErrorCode) {
    super("payment action refused");
  }
}

type PaymentDbRow = {
  id: string;
  customer_id: string;
  gateway: string;
  merchant_transaction_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: Date;
  verified_at: Date | null;
};

const LIST_COLUMNS = sql`id, customer_id, gateway, merchant_transaction_id, amount_minor::text as amount_minor, currency, status, created_at, verified_at`;

const toListRow = (r: PaymentDbRow): PaymentListRow => ({
  id: r.id,
  customerId: r.customer_id,
  gateway: r.gateway,
  merchantTransactionId: r.merchant_transaction_id,
  amountMinor: BigInt(r.amount_minor),
  currency: r.currency,
  status: r.status,
  createdAt: r.created_at,
  verifiedAt: r.verified_at,
});

type DiscrepancyDbRow = {
  id: string;
  kind: string;
  status: string;
  created_at: Date;
  payment_id: string | null;
  reason: string | null;
  expected: string | null;
  got: string | null;
};

const DISCREPANCY_COLUMNS = sql`id, kind, status, created_at,
  case when kind = 'payment' then details->>'paymentId' end as payment_id,
  case when kind = 'payment' then details->>'reason' end as reason,
  case when kind = 'payment' then details->>'expectedMinor' end as expected,
  case when kind = 'payment' then details->>'gotMinor' end as got`;

const minorOrNull = (text: string | null): bigint | null =>
  typeof text === "string" && WHOLE_NUMBER.test(text) ? BigInt(text) : null;

const toDiscrepancy = (r: DiscrepancyDbRow): DiscrepancyRow => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  createdAt: r.created_at,
  paymentId: typeof r.payment_id === "string" && isUuid(r.payment_id) ? r.payment_id : null,
  reason: typeof r.reason === "string" && REASON_CODE.test(r.reason) ? r.reason : null,
  expectedMinor: minorOrNull(r.expected),
  gotMinor: minorOrNull(r.got),
});

// The flat values of the payload only: short text, numbers, booleans, null. Nothing nested (R14).
function flatPayload(value: unknown): PaymentAdminDetail["verifyPayload"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (!PAYLOAD_KEY.test(key)) continue;
    if (item === null || typeof item === "boolean" || typeof item === "number") out[key] = item;
    else if (typeof item === "string" && item.length <= 120) out[key] = item;
  }
  return out;
}

const pageSize = (limit: number | undefined): number | null => {
  if (limit === undefined) return DEFAULT_PAGE;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE ? limit : null;
};

const isAmount = (value: unknown): value is bigint =>
  typeof value === "bigint" && value > 0n && value <= MAX_MINOR;

export function paymentsAdminRepo(scope: AdminScope): PaymentsAdminRepo {
  const role = scope.actor.role;
  const { tx, actor } = scope;

  return {
    async search(input) {
      if (!READ_ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { q, status, limit, after } = input ?? {};
      const size = pageSize(limit);
      if (
        size === null ||
        (q !== undefined && (typeof q !== "string" || q.length > MAX_QUERY)) ||
        (status !== undefined &&
          status !== "pending" &&
          !(PAYMENT_STATUSES as readonly string[]).includes(status)) ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      const term = (q ?? "").trim();
      const conditions: SQL[] = [sql`true`];
      if (term !== "") {
        if (isUuid(term)) conditions.push(sql`(id = ${term} or customer_id = ${term})`);
        else if (MERCHANT_TRANSACTION_ID.test(term)) {
          conditions.push(sql`merchant_transaction_id = ${term}`);
        } else conditions.push(sql`false`);
      }
      if (status === "pending") conditions.push(sql`status in ('initiated', 'redirected')`);
      else if (status !== undefined) conditions.push(sql`status = ${status}`);
      if (after !== undefined) conditions.push(sql`id < ${after}`);
      const where = sql.join(conditions, sql` and `);
      const result = await tx.execute<PaymentDbRow>(
        sql`select ${LIST_COLUMNS} from payments where ${where} order by id desc limit ${size + 1}`,
      );
      const page = result.rows.slice(0, size);
      return {
        ok: true,
        replayed: false,
        value: {
          rows: page.map(toListRow),
          nextAfter: result.rows.length > size ? (page[page.length - 1]?.id ?? null) : null,
        },
      };
    },

    async detail(paymentId) {
      if (!READ_ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (typeof paymentId !== "string" || !isUuid(paymentId)) return refused("not_found");
      const found = await tx.execute<
        PaymentDbRow & {
          gateway_transaction_id: string | null;
          ledger_transaction_id: string | null;
          verify_payload: unknown;
        }
      >(
        sql`select ${LIST_COLUMNS}, gateway_transaction_id, ledger_transaction_id, verify_payload from payments where id = ${paymentId}`,
      );
      const row = found.rows[0];
      if (row === undefined) return refused("not_found");
      const refund = await tx.execute<{ id: string; amount: string; created_at: Date }>(
        sql`select t.id, e.amount_minor::text as amount, t.created_at
              from ledger_transactions t
              join ledger_entries e on e.transaction_id = t.id
              join ledger_accounts a on a.id = e.account_id and a.type = 'refunds'
             where t.kind = 'refund' and t.reference_type = 'payment' and t.reference_id = ${paymentId}
             limit 1`,
      );
      const queue = await tx.execute<DiscrepancyDbRow>(
        sql`select ${DISCREPANCY_COLUMNS} from discrepancies
             where kind = 'payment' and details->>'paymentId' = ${paymentId}
             order by created_at desc, id desc limit 20`,
      );
      const refundRow = refund.rows[0];
      return {
        ok: true,
        replayed: false,
        value: {
          ...toListRow(row),
          gatewayTransactionId: row.gateway_transaction_id,
          ledgerTransactionId: row.ledger_transaction_id,
          verifyPayload: flatPayload(row.verify_payload),
          refund:
            refundRow === undefined
              ? null
              : {
                  transactionId: refundRow.id,
                  amountMinor: BigInt(refundRow.amount),
                  createdAt: refundRow.created_at,
                },
          discrepancies: queue.rows.map(toDiscrepancy),
        },
      };
    },

    async reverify(input, reason) {
      const paymentId = input?.paymentId;
      if (!FINANCE_ONLY.includes(role)) return refused("forbidden");
      if (typeof paymentId !== "string" || !isUuid(paymentId)) return refused("validation");
      const id = paymentId.toLowerCase();
      const note = typeof reason === "string" ? reason.trim() : "";
      try {
        return await audited(
          scope,
          { action: "payment.reverify", targetType: "payment", targetId: id, reason: note },
          async () => {
            const { rows } = await tx.execute<{ status: string; customer_id: string }>(
              sql`select status, customer_id from payments where id = ${id} for update`,
            );
            const current = rows[0];
            if (current === undefined) throw new Refusal("not_found");
            const before = { status: current.status };
            if (current.status === "redirected") {
              return {
                value: { id, status: "redirected" },
                replayed: true,
                before,
                after: before,
              };
            }
            // Only a payment that stopped (a mismatch under review, or past its 24 hours) can be
            // asked again; a credited, failed or cancelled payment is final.
            if (current.status !== "review" && current.status !== "expired") {
              throw new Refusal("conflict");
            }
            await tx.execute(
              sql`update payments set status = 'redirected' where id = ${id} and status in ('review', 'expired')`,
            );
            return {
              value: { id, status: "redirected" },
              replayed: false,
              before,
              after: { status: "redirected" },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    async recordManualRefund(input, reason, post) {
      const { paymentId, amountMinor } = input ?? {};
      if (!FINANCE_ONLY.includes(role)) return refused("forbidden");
      if (
        typeof paymentId !== "string" ||
        !isUuid(paymentId) ||
        !isAmount(amountMinor) ||
        typeof post !== "function"
      ) {
        return refused("validation");
      }
      const id = paymentId.toLowerCase();
      const note = typeof reason === "string" ? reason.trim() : "";
      const key = `refund:${id}`;
      try {
        return await audited(
          scope,
          { action: "payment.refund", targetType: "payment", targetId: id, reason: note },
          async () => {
            // Two overlapping submits of one refund meet here; the second reads the first one's line.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${"refund:" + id}, 0))`,
            );
            const { rows } = await tx.execute<{
              customer_id: string;
              amount: string;
              status: string;
            }>(
              sql`select customer_id, amount_minor::text as amount, status from payments where id = ${id} for update`,
            );
            const payment = rows[0];
            if (payment === undefined) throw new Refusal("not_found");
            if (payment.status !== "credited") throw new Refusal("conflict");
            if (amountMinor > BigInt(payment.amount)) throw new Refusal("validation");
            const meta = { customerId: payment.customer_id, amountMinor: amountMinor.toString() };
            const earlier = await tx.execute<{ id: string; amount: string }>(
              sql`select t.id, e.amount_minor::text as amount
                    from ledger_transactions t
                    join ledger_entries e on e.transaction_id = t.id
                    join ledger_accounts a on a.id = e.account_id and a.type = 'refunds'
                   where t.idempotency_key = ${key}`,
            );
            const done = earlier.rows[0];
            if (done !== undefined) {
              if (BigInt(done.amount) !== amountMinor) throw new Refusal("conflict");
              return {
                value: {
                  paymentId: id,
                  customerId: payment.customer_id,
                  amountMinor,
                  ledgerTransactionId: done.id,
                },
                replayed: true,
                before: meta,
                after: { ...meta, ledgerTransactionId: done.id },
              };
            }
            const wallet = { type: "customer_wallet", customerId: payment.customer_id } as const;
            const posted = await post(tx, {
              kind: "refund",
              reference: { type: "payment", id },
              idempotencyKey: key,
              actor: { type: "admin", id: actor.adminId },
              memo: note,
              postings: [
                { account: wallet, direction: "debit", amountMinor },
                { account: { type: "refunds" }, direction: "credit", amountMinor },
              ],
            });
            // A refused posting wrote nothing: not enough money in the wallet, a second refund, a check of core.
            if (!posted.ok) throw new Refusal("conflict");
            return {
              value: {
                paymentId: id,
                customerId: payment.customer_id,
                amountMinor,
                ledgerTransactionId: posted.value.transactionId,
              },
              replayed: false,
              before: null,
              after: { ...meta, ledgerTransactionId: posted.value.transactionId },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    async discrepancies(input) {
      if (!QUEUE_ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { kind, status, limit } = input ?? {};
      const size = pageSize(limit);
      if (
        size === null ||
        (kind !== undefined && !(DISCREPANCY_KINDS as readonly string[]).includes(kind)) ||
        (status !== undefined && !(DISCREPANCY_STATUSES as readonly string[]).includes(status))
      ) {
        return refused("validation");
      }
      const conditions: SQL[] = [sql`true`];
      if (kind !== undefined) conditions.push(sql`kind = ${kind}`);
      if (status !== undefined) conditions.push(sql`status = ${status}`);
      const where = sql.join(conditions, sql` and `);
      const result = await tx.execute<DiscrepancyDbRow>(
        sql`select ${DISCREPANCY_COLUMNS} from discrepancies where ${where} order by created_at desc, id desc limit ${size}`,
      );
      return { ok: true, replayed: false, value: result.rows.map(toDiscrepancy) };
    },

    async resolveDiscrepancy(input, reason) {
      const id = input?.id;
      if (!QUEUE_ROLES.includes(role)) return refused("forbidden");
      if (typeof id !== "string" || !isUuid(id)) return refused("validation");
      const note = typeof reason === "string" ? reason.trim() : "";
      try {
        return await audited(
          scope,
          { action: "discrepancy.resolve", targetType: "discrepancy", targetId: id, reason: note },
          async () => {
            const { rows } = await tx.execute<{ kind: string; status: string }>(
              sql`select kind, status from discrepancies where id = ${id} for update`,
            );
            const current = rows[0];
            if (current === undefined) throw new Refusal("not_found");
            const before = { kind: current.kind, status: current.status };
            if (current.status === "resolved") {
              return { value: { id, status: "resolved" }, replayed: true, before, after: before };
            }
            await tx.execute(sql`update discrepancies set status = 'resolved' where id = ${id}`);
            return {
              value: { id, status: "resolved" },
              replayed: false,
              before,
              after: { kind: current.kind, status: "resolved" },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },
  };
}
