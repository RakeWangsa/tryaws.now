import { sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { INVOICE_BACKLOG_SOURCE, INVOICE_UNRECORDED_SOURCE } from "../customer/invoices";
import { isUuid } from "../scope";

// WPU-I2: the charges whose tax invoice waits for the seller details. They are rows of `discrepancies`
// (kind missing, details.source invoice_seller_missing) written by invoices.queueBacklog when the charge
// was made. System module (the scheduler, worker_rw): it lists the pending charges of every customer in
// the order of the charge and takes no customer id; the invoice itself is issued through
// customerRepos(tx, row.customerId).invoices, so the tenant checks of the issue apply (R8). A charge is
// pending while no invoice carries its ledger transaction. Resolving the notice in the admin queue does
// not cancel the invoice that is owed. A row whose details do not parse is never guessed (R16).
//
// WPU-I5. The queue is closed by MARKER rows (kind missing, details.source invoice_backlog_mark, details.for =
// the id of the queue row), because the details of a row are never rewritten: state `resolved` (the charge
// was reversed: no invoice is owed) and `skipped` (the row cannot be read) take the row out of the list;
// state `failed` leaves it in the list (nothing may overtake it) and is the notice for a person. A marker
// is written once for a state and a reason (its id is derived). The scheduler may set the status of a
// row to resolved (migration 0018) and nothing else.
export const INVOICE_MARK_SOURCE = "invoice_backlog_mark";
export const CREDIT_NOTE_SOURCE = "credit_note_needed";

export interface PendingInvoice {
  readonly discrepancyId: string;
  readonly customerId: string;
  readonly kind: "order" | "renewal";
  readonly orderId: string | null;
  readonly ledgerTransactionId: string;
  readonly lines: readonly unknown[];
  readonly totalMinor: bigint;
  readonly queuedAt: Date;
  /** The ledger transaction of the charge has a reversal: no invoice is owed (WPU-I5). */
  readonly reversed: boolean;
}

export interface PendingInvoices {
  /** Oldest charge first (queue time, then id): the order of issue. */
  readonly items: PendingInvoice[];
  /** How many rows of the queue could not be read; they need a person. */
  readonly unreadable: number;
  /** Their ids; the run marks them skipped so that the readable ones go on (WPU-I5). */
  readonly unreadableIds: string[];
}

export type BacklogMarkState = "resolved" | "skipped" | "failed";

export interface BacklogMark {
  readonly discrepancyId: string;
  /** Null for a row that cannot be read. */
  readonly ledgerTransactionId: string | null;
  readonly state: BacklogMarkState;
  /** A fixed code: charge_reversed, unreadable, refused:<code>. Never a message with a value (R14). */
  readonly reason: string;
}

/** A recent charge with no invoice, no queue row and no notice (WPU-I5). */
export interface UnrecordedCharge {
  readonly customerId: string;
  readonly kind: "order" | "renewal";
  readonly orderId: string | null;
  readonly ledgerTransactionId: string;
  readonly totalMinor: bigint;
  /** The snapshot that priced an order (the order row); null for a renewal. */
  readonly priceSnapshot: unknown;
  /**
   * WPU-Y9. The price snapshot saved with the charge itself (ledger_transactions.price_snapshot, WPU-Y2): the
   * source of the invoice lines. Null for a charge from before it existed (legacy).
   */
  readonly chargeSnapshot: unknown;
}

/** WPU-C1: a reversal of a charge with an issued invoice and no credit note yet. */
export interface CreditNoteToIssue {
  readonly customerId: string;
  /** The reversal transaction the credit note answers. */
  readonly reversalTransactionId: string;
  /** The ledger transaction of the original charge (names the notice row). */
  readonly ledgerTransactionId: string;
  /** WPU-B3: when the reversal was posted; a credit note that is refused for long is escalated by its age. */
  readonly reversedAt: Date;
}

export interface InvoiceBacklogRepo {
  pending(limit: number): Promise<PendingInvoices>;
  mark(mark: BacklogMark): Promise<void>;
  /** Charges of the last `windowDays` days that nobody records: the reconciliation of the scheduler. */
  unrecorded(limit: number, windowDays: number): Promise<UnrecordedCharge[]>;
  /** Ledger transactions with an issued invoice and a reversal but no credit-note notice yet. */
  creditNotesDue(limit: number): Promise<string[]>;
  /** WPU-C1: reversals with an issued invoice and no credit note, oldest reversal first (the order of issue). */
  creditNotesToIssue(limit: number): Promise<CreditNoteToIssue[]>;
  /** WPU-C1: the credit note is issued: the `credit_note_needed` notice of the charge is resolved. */
  resolveCreditNoteNotice(ledgerTransactionId: string): Promise<void>;
  /**
   * An issued invoice whose charge was reversed needs a credit note (Mushak 6.7). Writes the notice once
   * and returns true; false when the charge has no invoice or the notice exists.
   */
  creditNoteNeeded(ledgerTransactionId: string): Promise<boolean>;
}

const MAX_PENDING = 500;
const MAX_PAGES = 20;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const REASON = /^[a-z][a-z_:0-9]{0,59}$/;

function parseDetails(
  id: string,
  createdAt: Date,
  details: unknown,
  reversed: boolean,
): PendingInvoice | null {
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
    reversed,
  };
}

export function invoiceBacklogRepo(tx: Tx): InvoiceBacklogRepo {
  type Row = {
    id: string;
    details: unknown;
    created_at: Date;
    created_text: string;
    reversed: boolean;
  };
  // One page of the queue after the cursor. One entry for each charge (the first one) whose invoice does
  // not exist yet and whose row is not closed by a marker. The cursor is the exact text of the timestamp.
  const page = async (
    cursor: { createdText: string; id: string } | null,
    size: number,
  ): Promise<Row[]> => {
    const after =
      cursor === null
        ? sql``
        : sql`where (created_at, id) > (${cursor.createdText}::timestamptz, ${cursor.id}::uuid)`;
    const rows = await tx.execute<Row>(sql`
      select id, details, created_at, created_at::text as created_text, reversed from (
        select distinct on (coalesce(d.details->>'ledgerTransactionId', d.id::text))
               d.id, d.details, d.created_at,
               exists (select 1 from ledger_transactions r
                        where r.kind = 'reversal' and r.reference_type = 'ledger_transaction'
                          and r.reference_id::text = d.details->>'ledgerTransactionId') as reversed
        from discrepancies d
        where d.kind = 'missing' and d.details->>'source' = ${INVOICE_BACKLOG_SOURCE}
          and not exists (select 1 from invoices i
                          where i.ledger_transaction_id::text = d.details->>'ledgerTransactionId')
          and not exists (select 1 from discrepancies k
                          where k.details->>'source' = ${INVOICE_MARK_SOURCE}
                            and k.details->>'for' = d.id::text
                            and k.details->>'state' in ('resolved', 'skipped'))
        order by coalesce(d.details->>'ledgerTransactionId', d.id::text), d.created_at, d.id) first_entry
      ${after}
      order by created_at asc, id asc
      limit ${size}`);
    return rows.rows;
  };

  return {
    async pending(limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError("invoiceBacklog: limit");
      const want = Math.min(limit, MAX_PENDING);
      const items: PendingInvoice[] = [];
      const unreadableIds: string[] = [];
      let cursor: { createdText: string; id: string } | null = null;
      // WPU-I5: unreadable rows do not use up the limit: the next page is read until `want` readable
      // items are found or the queue ends.
      for (let i = 0; i < MAX_PAGES && items.length < want; i += 1) {
        const size = want - items.length;
        const rows = await page(cursor, size);
        for (const r of rows) {
          const parsed = parseDetails(r.id, new Date(r.created_at), r.details, r.reversed === true);
          if (parsed === null) unreadableIds.push(r.id);
          else items.push(parsed);
        }
        const last = rows[rows.length - 1];
        if (last === undefined || rows.length < size) break;
        cursor = { createdText: last.created_text, id: last.id };
      }
      return { items, unreadable: unreadableIds.length, unreadableIds };
    },

    async mark(mark) {
      if (
        !isUuid(mark.discrepancyId) ||
        (mark.ledgerTransactionId !== null && !isUuid(mark.ledgerTransactionId)) ||
        !["resolved", "skipped", "failed"].includes(mark.state) ||
        !REASON.test(mark.reason)
      ) {
        throw new TypeError("invoiceBacklog: mark");
      }
      const details = {
        source: INVOICE_MARK_SOURCE,
        v: 1,
        for: mark.discrepancyId,
        state: mark.state,
        reason: mark.reason,
        ...(mark.ledgerTransactionId === null
          ? {}
          : { ledgerTransactionId: mark.ledgerTransactionId }),
      };
      const markerId = sql`md5(${`invoice-mark|${mark.state}|${mark.reason}|${mark.discrepancyId}`})::uuid`;
      await tx.execute(sql`
        insert into discrepancies (id, kind, details)
        values (${markerId}, 'missing', ${JSON.stringify(details)}::jsonb)
        on conflict (id) do nothing`);
      if (mark.state === "resolved") {
        // The marker, the queue row and any other queue row of the same charge: nothing is owed.
        await tx.execute(sql`
          update discrepancies set status = 'resolved'
          where status = 'open'
            and (id = ${markerId} or id = ${mark.discrepancyId}::uuid
                 or (details->>'source' = ${INVOICE_BACKLOG_SOURCE}
                     and details->>'ledgerTransactionId' = ${mark.ledgerTransactionId}))`);
      }
    },

    async unrecorded(limit, windowDays) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        !Number.isInteger(windowDays) ||
        windowDays < 0
      ) {
        throw new TypeError("invoiceBacklog: unrecorded");
      }
      const recorded = sql`
        not exists (select 1 from invoices i where i.ledger_transaction_id = lt.id)
        and not exists (select 1 from discrepancies d
                         where d.details->>'source' in (${INVOICE_BACKLOG_SOURCE}, ${INVOICE_UNRECORDED_SOURCE})
                           and d.details->>'ledgerTransactionId' = lt.id::text)
        and not exists (select 1 from ledger_transactions r
                         where r.kind = 'reversal' and r.reference_type = 'ledger_transaction'
                           and r.reference_id = lt.id)`;
      const rows = await tx.execute<{
        ltx: string;
        kind: "order" | "renewal";
        order_id: string | null;
        customer_id: string;
        total: string;
        snapshot: unknown;
        charge_snapshot: unknown;
      }>(sql`
        select * from (
          select lt.id::text as ltx, 'order'::text as kind, o.id::text as order_id,
                 o.customer_id::text as customer_id, o.total_minor::text as total,
                 o.price_snapshot as snapshot, lt.price_snapshot as charge_snapshot, lt.created_at
          from orders o join ledger_transactions lt on lt.id = o.ledger_transaction_id
          where lt.created_at >= now() - make_interval(days => ${windowDays})
            and o.total_minor > 0 and ${recorded}
          union all
          select lt.id::text, 'renewal'::text, null::text, sub.customer_id::text,
                 (select coalesce(sum(e.amount_minor), 0)::text from ledger_entries e
                    join ledger_accounts a on a.id = e.account_id
                   where e.transaction_id = lt.id and a.type = 'customer_wallet'
                     and e.direction = 'debit'),
                 null::jsonb, lt.price_snapshot, lt.created_at
          from ledger_transactions lt join subscriptions sub on sub.id = lt.reference_id
          where lt.kind = 'renewal' and lt.reference_type = 'subscription'
            and lt.created_at >= now() - make_interval(days => ${windowDays}) and ${recorded}
        ) u
        order by created_at asc, ltx asc
        limit ${Math.min(limit, MAX_PENDING)}`);
      return rows.rows.map((r) => ({
        customerId: r.customer_id,
        kind: r.kind,
        orderId: r.order_id,
        ledgerTransactionId: r.ltx,
        totalMinor: BigInt(r.total),
        priceSnapshot: r.snapshot,
        chargeSnapshot: r.charge_snapshot ?? null,
      }));
    },

    async creditNotesDue(limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError("invoiceBacklog: limit");
      const rows = await tx.execute<{ id: string }>(sql`
        select i.ledger_transaction_id::text as id
        from invoices i
        where i.ledger_transaction_id is not null
          and exists (select 1 from ledger_transactions r
                       where r.kind = 'reversal' and r.reference_type = 'ledger_transaction'
                         and r.reference_id = i.ledger_transaction_id)
          and not exists (select 1 from discrepancies d
                           where d.id = md5('credit-note|' || i.ledger_transaction_id::text)::uuid)
        order by i.issued_at asc, i.id asc
        limit ${Math.min(limit, MAX_PENDING)}`);
      return rows.rows.map((r) => r.id);
    },

    async creditNotesToIssue(limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError("invoiceBacklog: limit");
      const rows = await tx.execute<{
        customer_id: string;
        reversal_id: string;
        ltx: string;
        reversed_at: Date | string;
      }>(sql`
        select i.customer_id::text as customer_id, rv.id::text as reversal_id,
               i.ledger_transaction_id::text as ltx, rv.created_at as reversed_at
        from invoices i
        join ledger_transactions rv on rv.kind = 'reversal' and rv.reference_type = 'ledger_transaction'
                                   and rv.reference_id = i.ledger_transaction_id
        where i.kind = 'invoice' and i.ledger_transaction_id is not null
          and not exists (select 1 from invoices c where c.credit_for_ledger_transaction_id = rv.id)
        order by rv.created_at asc, rv.id asc
        limit ${Math.min(limit, MAX_PENDING)}`);
      return rows.rows.map((r) => ({
        customerId: r.customer_id,
        reversalTransactionId: r.reversal_id,
        ledgerTransactionId: r.ltx,
        reversedAt: r.reversed_at instanceof Date ? r.reversed_at : new Date(r.reversed_at),
      }));
    },

    async resolveCreditNoteNotice(ledgerTransactionId) {
      if (!isUuid(ledgerTransactionId))
        throw new TypeError("invoiceBacklog: resolveCreditNoteNotice");
      // Only the status of the notice row of this charge (migration 0018 lets the scheduler set the status).
      await tx.execute(sql`
        update discrepancies set status = 'resolved'
        where id = md5(${`credit-note|${ledgerTransactionId}`})::uuid and status = 'open'`);
    },

    async creditNoteNeeded(ledgerTransactionId) {
      if (!isUuid(ledgerTransactionId)) throw new TypeError("invoiceBacklog: creditNoteNeeded");
      // The invoice of the charge (an order's or a renewal's) is a legal document and is not changed; a
      // credit note (Mushak 6.7) is for a person to issue. Ids, the number and the amount only (R14).
      const inserted = await tx.execute(sql`
        insert into discrepancies (id, kind, details)
        select md5(${`credit-note|${ledgerTransactionId}`})::uuid, 'missing',
               jsonb_build_object('source', ${CREDIT_NOTE_SOURCE}::text, 'v', 1,
                                  'customerId', i.customer_id, 'invoiceId', i.id,
                                  'fiscalYear', i.fiscal_year, 'number', i.number,
                                  'ledgerTransactionId', i.ledger_transaction_id,
                                  'totalMinor', i.total_minor::text)
        from invoices i where i.ledger_transaction_id = ${ledgerTransactionId}::uuid
        on conflict (id) do nothing`);
      return inserted.rowCount === 1;
    },
  };
}
