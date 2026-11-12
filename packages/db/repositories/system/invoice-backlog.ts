import { sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { INVOICE_BACKLOG_SOURCE } from "../customer/invoices";
import { isUuid } from "../scope";

// WPU-I2: the charges whose tax invoice waits for the seller details. They are rows of `discrepancies`
// (kind missing, details.source invoice_seller_missing) written by invoices.queueBacklog when the charge
// was made. System module (the scheduler, worker_rw): it lists the pending charges of every customer in
// the order of the charge and takes no customer id; the invoice itself is issued through
// customerRepos(tx, row.customerId).invoices, so the tenant checks of the issue apply (R8). A charge is
// pending while no invoice carries its ledger transaction. Resolving the notice in the admin queue does
// not cancel the invoice that is owed. A row whose details do not parse is counted, not guessed (R16).
export interface PendingInvoice {
  readonly discrepancyId: string;
  readonly customerId: string;
  readonly kind: "order" | "renewal";
  readonly orderId: string | null;
  readonly ledgerTransactionId: string;
  readonly lines: readonly unknown[];
  readonly totalMinor: bigint;
  readonly queuedAt: Date;
}

export interface PendingInvoices {
  /** Oldest charge first (queue time, then id): the order of issue. */
  readonly items: PendingInvoice[];
  /** Rows of the queue that could not be read; they stay owed and need a person. */
  readonly unreadable: number;
}

export interface InvoiceBacklogRepo {
  pending(limit: number): Promise<PendingInvoices>;
}

const MAX_PENDING = 500;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;

function parseDetails(id: string, createdAt: Date, details: unknown): PendingInvoice | null {
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  const kind = d["charge"];
  const orderId = d["orderId"];
  const total = d["totalMinor"];
  if (
    d["source"] !== INVOICE_BACKLOG_SOURCE ||
    d["v"] !== 1 ||
    (kind !== "order" && kind !== "renewal") ||
    typeof d["customerId"] !== "string" ||
    !isUuid(d["customerId"]) ||
    typeof d["ledgerTransactionId"] !== "string" ||
    !isUuid(d["ledgerTransactionId"]) ||
    (kind === "order") !== (typeof orderId === "string") ||
    (typeof orderId === "string" && !isUuid(orderId)) ||
    typeof total !== "string" ||
    !DECIMAL.test(total) ||
    !Array.isArray(d["lines"]) ||
    d["lines"].length === 0
  ) {
    return null;
  }
  return {
    discrepancyId: id,
    customerId: d["customerId"],
    kind,
    orderId: typeof orderId === "string" ? orderId : null,
    ledgerTransactionId: d["ledgerTransactionId"],
    lines: d["lines"] as unknown[],
    totalMinor: BigInt(total),
    queuedAt: createdAt,
  };
}

export function invoiceBacklogRepo(tx: Tx): InvoiceBacklogRepo {
  return {
    async pending(limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError("invoiceBacklog: limit");
      // One entry for each charge (the first one), whose invoice does not exist yet.
      const rows = await tx.execute<{ id: string; details: unknown; created_at: Date }>(sql`
        select id, details, created_at from (
          select distinct on (d.details->>'ledgerTransactionId') d.id, d.details, d.created_at
          from discrepancies d
          where d.kind = 'missing' and d.details->>'source' = ${INVOICE_BACKLOG_SOURCE}
            and not exists (select 1 from invoices i
                            where i.ledger_transaction_id::text = d.details->>'ledgerTransactionId')
          order by d.details->>'ledgerTransactionId', d.created_at, d.id) first_entry
        order by created_at asc, id asc
        limit ${Math.min(limit, MAX_PENDING)}`);
      const items: PendingInvoice[] = [];
      let unreadable = 0;
      for (const r of rows.rows) {
        const parsed = parseDetails(r.id, new Date(r.created_at), r.details);
        if (parsed === null) unreadable += 1;
        else items.push(parsed);
      }
      return { items, unreadable };
    },
  };
}
