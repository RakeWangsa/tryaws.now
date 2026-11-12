import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { invoices } from "../../schema/index";
import {
  INVOICE_SELLER_KEY,
  parseSellerRowValue,
  sellerRowValueOf,
} from "../config/invoice-seller";
import { created, refused, replayed, type Written } from "../result";
import { BUYER_ADDRESS_MAX, BUYER_NAME_MAX, buyerTextLength } from "./buyer-rules";
import { isUuid, type TenantScope } from "../scope";

// An invoice of the customer, as the list and the invoice page read it. The customer id is not a
// field: the scope holds it (R8). `lines` holds the stored lines of packages/core/invoices (amounts
// as decimal strings), which the page parses with the core, not here.
export interface InvoiceRow {
  id: string;
  fiscalYear: number;
  number: number;
  orderId: string | null;
  lines: unknown;
  totalMinor: bigint;
  issuedAt: Date;
  pdfKey: string | null;
  // WPU-I2: the seller details of the day of issue (the stored value of the `invoice_seller` setting at
  // that time), or null for a row issued before the column existed. A reprint reads this, never the
  // current setting. The reader parses it (parseSellerRowValue) and refuses what does not parse.
  seller: unknown;
  // WPU-I2: the money transaction of the charge this invoice is for.
  ledgerTransactionId: string | null;
  // WPU-I3: the buyer as the billing profile read on the day of issue, or null (none entered). Stored
  // jsonb, parsed by parseBuyerSnapshot of the core; contains personal identifiers: never logged (R14).
  buyer: unknown;
}

// The buyer snapshot as the caller passes it (the shape of BuyerSnapshot of packages/core/invoices).
export interface NewInvoiceBuyer {
  name: string | null;
  address: string | null;
  taxId: { kind: "bin" | "nid"; value: string } | null;
}

export interface NewInvoice {
  id: string;
  orderId: string;
  // First calendar year of the fiscal year (fiscalYearOf of packages/core/invoices).
  fiscalYear: number;
  lines: readonly unknown[];
  totalMinor: bigint;
  // WPU-I3: optional. The caller reads the customer's billing profile (profile.getBilling) in the same
  // transaction and passes the buyer; it is stored with the invoice. Omitted: the invoice has no buyer.
  buyer?: NewInvoiceBuyer | null;
  // WPU-I5: the instant of issue. The fiscal year above must be the fiscal year of THIS instant (checked
  // here, refused as validation otherwise) and it is stored as issued_at, so the printed date and the
  // number's year never disagree. Every caller of the platform passes it; omitted, the database clock is
  // used for the date and the year is not cross-checked (test fixtures only).
  issuedAt?: Date;
}

// WPU-I2: the invoice of a charge that has no order (a renewal). The ledger transaction is the
// reference; it must be the customer's own renewal charge and its wallet debit must be the total.
export interface NewChargeInvoice {
  id: string;
  ledgerTransactionId: string;
  fiscalYear: number;
  lines: readonly unknown[];
  totalMinor: bigint;
  // WPU-I4: the buyer, as for NewInvoice: read from the billing profile in the same transaction.
  buyer?: NewInvoiceBuyer | null;
  // WPU-I5: as for NewInvoice.
  issuedAt?: Date;
}

// WPU-I2: a charge whose invoice waits for the seller details. The lines are those of the charge.
export interface NewBacklogEntry {
  id: string;
  kind: "order" | "renewal";
  orderId?: string;
  ledgerTransactionId: string;
  lines: readonly unknown[];
  totalMinor: bigint;
}

// The `source` of the discrepancy that holds a charge whose invoice is owed (WPU-I2).
export const INVOICE_BACKLOG_SOURCE = "invoice_seller_missing";
// WPU-I5: a charge that has no invoice and could not be queued with its lines (ids and the amount only):
// a person must look at it. Written by the live path or by the scheduler's reconciliation.
export const INVOICE_UNRECORDED_SOURCE = "invoice_charge_unrecorded";

// WPU-I5: the charge whose invoice is owed but whose lines are not available.
export interface NewUnrecordedCharge {
  id: string;
  kind: "order" | "renewal";
  orderId?: string;
  ledgerTransactionId: string;
  totalMinor: bigint;
}

// Keyset cursor: (fiscal year, number) is unique, so the order is exact and no row is skipped or
// repeated, as it could be with a timestamp.
export interface InvoiceCursor {
  fiscalYear: number;
  number: number;
}

export interface InvoicePage {
  items: InvoiceRow[];
  next: InvoiceCursor | null;
}

export const DEFAULT_INVOICE_PAGE = 25;
export const MAX_INVOICE_PAGE = 100;

// issue is the single place that creates an invoice (9.3: the trigger may move). It runs inside the
// transaction of the purchase or the renewal, so that a rollback frees the number: the numbers of a
// fiscal year have no gap. Receipts of top-ups are not stored here (see JOURNEY.md, WP3-T5).
export interface InvoicesRepo {
  get(id: string): Promise<InvoiceRow | null>;
  findByOrder(orderId: string): Promise<InvoiceRow | null>;
  list(opts?: { limit?: number; after?: InvoiceCursor }): Promise<InvoicePage>;
  issue(input: NewInvoice): Promise<IssueResult>;
  issueForCharge(input: NewChargeInvoice): Promise<IssueResult>;
  // Records that the invoice of a charge is owed (the seller details are missing): one row of the admin
  // queue (`discrepancies`, kind `missing`) that holds the lines, so that the scheduler issues the same
  // invoice later. The money is not touched.
  queueBacklog(input: NewBacklogEntry): Promise<Written<{ queued: true }>>;
  // WPU-I5: true while an older charge of the market of this customer is still owed its invoice. A new
  // charge is then queued too, so that its number is not taken before the older ones (numbers follow the
  // order of the charge). Answered by a function that returns one boolean: web_rw cannot read the queue.
  backlogBlocked(): Promise<boolean>;
  // WPU-I5: the notice (ids and the amount, no lines) for a charge whose lines cannot be queued.
  noteUnrecorded(input: NewUnrecordedCharge): Promise<Written<{ noted: true }>>;
}

// WPU-I1: a tax invoice (Mushak 6.3) names its seller. Without complete seller details (the setting
// `invoice_seller` of the customer's market) nothing is issued and no number is taken (R16); the admin
// queue shows the notice.
// WPU-I5: a charge that was reversed (the money went back) is owed no invoice: `charge_reversed`.
export type IssueResult =
  | Written<InvoiceRow>
  | { ok: false; error: "seller_details_missing" }
  | { ok: false; error: "charge_reversed" };

const INVOICE_COLUMNS = {
  id: invoices.id,
  fiscalYear: invoices.fiscalYear,
  number: invoices.number,
  orderId: invoices.orderId,
  lines: invoices.lines,
  totalMinor: invoices.totalMinor,
  issuedAt: invoices.issuedAt,
  pdfKey: invoices.pdfKey,
  seller: invoices.seller,
  ledgerTransactionId: invoices.ledgerTransactionId,
  buyer: invoices.buyer,
};

const toInvoice = (row: Record<keyof InvoiceRow, unknown>): InvoiceRow =>
  row as unknown as InvoiceRow;

// Only the three named keys are stored: nothing else of the input reaches the row.
function buyerJsonOf(buyer: NewInvoiceBuyer | null | undefined): string | null {
  return buyer === undefined || buyer === null
    ? null
    : JSON.stringify({ name: buyer.name, address: buyer.address, taxId: buyer.taxId });
}

const DIGITS = /^[0-9]+$/;
const textOrNull = (v: unknown, max: number): boolean =>
  v === null || (typeof v === "string" && v !== "" && buyerTextLength(v) <= max);
function buyerValid(b: unknown): boolean {
  if (typeof b !== "object" || b === null || Array.isArray(b)) return false;
  const { name, address, taxId } = b as Record<string, unknown>;
  if (!textOrNull(name, BUYER_NAME_MAX) || !textOrNull(address, BUYER_ADDRESS_MAX)) return false;
  if (taxId === null) return true;
  if (typeof taxId !== "object" || Array.isArray(taxId)) return false;
  const { kind, value } = taxId as Record<string, unknown>;
  if (typeof value !== "string" || !DIGITS.test(value)) return false;
  return kind === "bin"
    ? value.length === 13
    : kind === "nid" && [10, 13, 17].includes(value.length);
}

// WPU-I5: the fiscal year (July to June, Dhaka UTC+6) of an instant, in the database, so that the year and
// the stored issued_at are checked against the same value.
async function fiscalYearMatches(
  tx: TenantScope["tx"],
  issuedAt: Date,
  fiscalYear: number,
): Promise<boolean> {
  const [row] = await tx
    .execute<{ fy: number }>(
      sql`select extract(year from ((${issuedAt.toISOString()}::timestamptz at time zone 'UTC') + interval '6 hours' - interval '6 months'))::int as fy`,
    )
    .then((r) => r.rows);
  return row !== undefined && Number(row.fy) === fiscalYear;
}
const validInstant = (at: unknown): boolean =>
  at === undefined || (at instanceof Date && !Number.isNaN(at.getTime()));

function requireUuid(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !isUuid(value)) {
    // Fixed text: the refused value is never part of a message (R14).
    throw new TypeError(`invoices: ${what} is not a UUID`);
  }
}

export function invoicesRepo(scope: TenantScope): InvoicesRepo {
  const { tx, customerId } = scope;

  const byColumn = async (
    column: typeof invoices.id | typeof invoices.orderId | typeof invoices.ledgerTransactionId,
    value: string,
  ): Promise<InvoiceRow | null> => {
    const [row] = await tx
      .select(INVOICE_COLUMNS)
      .from(invoices)
      .where(and(eq(column, value), eq(invoices.customerId, customerId)));
    return row === undefined ? null : toInvoice(row);
  };

  return {
    // null for a missing row, a row of another customer and an id that is not a UUID alike (R8).
    get: async (id) => (isUuid(id) ? byColumn(invoices.id, id) : null),

    findByOrder: async (orderId) => (isUuid(orderId) ? byColumn(invoices.orderId, orderId) : null),

    list: async (opts = {}) => {
      const limit = Number.isInteger(opts.limit)
        ? Math.min(Math.max(opts.limit as number, 1), MAX_INVOICE_PAGE)
        : DEFAULT_INVOICE_PAGE;
      const after = opts.after;
      if (
        after !== undefined &&
        (!Number.isInteger(after.fiscalYear) || !Number.isInteger(after.number))
      ) {
        return { items: [], next: null };
      }
      const own = eq(invoices.customerId, customerId);
      const rows = await tx
        .select(INVOICE_COLUMNS)
        .from(invoices)
        .where(
          after === undefined
            ? own
            : and(
                own,
                or(
                  lt(invoices.fiscalYear, after.fiscalYear),
                  and(eq(invoices.fiscalYear, after.fiscalYear), lt(invoices.number, after.number)),
                ),
              ),
        )
        .orderBy(desc(invoices.fiscalYear), desc(invoices.number))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map(toInvoice);
      const last = items[items.length - 1];
      return {
        items,
        next:
          rows.length > limit && last !== undefined
            ? { fiscalYear: last.fiscalYear, number: last.number }
            : null,
      };
    },

    issue: async (input) => {
      requireUuid(input.id, "id");
      requireUuid(input.orderId, "orderId");
      if (
        typeof input.totalMinor !== "bigint" ||
        input.totalMinor < 0n ||
        !Number.isInteger(input.fiscalYear) ||
        input.fiscalYear < 2026 ||
        input.fiscalYear > 32000 ||
        !Array.isArray(input.lines) ||
        input.lines.length === 0 ||
        !validInstant(input.issuedAt) ||
        (input.buyer !== undefined && input.buyer !== null && !buyerValid(input.buyer))
      ) {
        return refused("validation");
      }
      const buyerJson = buyerJsonOf(input.buyer);
      const fiscalYear = input.fiscalYear;
      if (
        input.issuedAt !== undefined &&
        !(await fiscalYearMatches(tx, input.issuedAt, fiscalYear))
      ) {
        return refused("validation");
      }
      const issuedAtText = input.issuedAt === undefined ? null : input.issuedAt.toISOString();
      // One invoice at a time per fiscal year: the lock is held to the end of the transaction, so the
      // next number is read after the previous one is committed or rolled back (gap-free).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('invoice-number'), ${fiscalYear}::int)`,
      );

      // One invoice per order (R7): the order is the reference, the unique key invoices_order_id_unique
      // backs it. A second call returns the first invoice and takes no number.
      const existing = await byColumn(invoices.orderId, input.orderId);
      if (existing !== null) {
        return existing.totalMinor === input.totalMinor ? replayed(existing) : refused("conflict");
      }

      // The order must be the customer's own (R8), and the seller of the customer's market must be
      // complete (R16). The order is looked at first, so another customer's order answers not_found.
      const [owned] = await tx
        .execute<{ seller: unknown; reversed: boolean }>(
          sql`select s.value as seller,
                     exists (select 1 from ledger_transactions r
                              where r.kind = 'reversal' and r.reference_type = 'ledger_transaction'
                                and r.reference_id = o.ledger_transaction_id) as reversed
              from orders o
              join customers c on c.id = o.customer_id
              left join settings s on s.market = c.market and s.key = ${INVOICE_SELLER_KEY} and s.scope = 'market'
              where o.id = ${input.orderId} and o.customer_id = ${customerId}`,
        )
        .then((r) => r.rows);
      if (owned === undefined) return refused("not_found");
      // WPU-I5: money that went back is owed no invoice (checked before the seller: nothing is queued).
      if (owned.reversed) return { ok: false, error: "charge_reversed" };
      const sellerNow = parseSellerRowValue(owned.seller);
      if (sellerNow === null) return { ok: false, error: "seller_details_missing" };
      // WPU-I2: the seller as it is now is written on the invoice, in the transaction of the issue.
      const sellerSnapshot = JSON.stringify(sellerRowValueOf(sellerNow.seller, sellerNow.version));

      // The order is selected by id and customer in the same statement as the insert, and its total
      // must be the total of the invoice: an order of another customer, a missing one and a wrong
      // total insert nothing (R8, R16).
      const inserted = await tx.execute(sql`
        insert into invoices (id, fiscal_year, number, customer_id, order_id, lines, total_minor, seller, ledger_transaction_id, buyer, issued_at)
        select ${input.id}, ${fiscalYear}::smallint,
               coalesce((select max(i.number) from invoices i where i.fiscal_year = ${fiscalYear}::smallint), 0) + 1,
               o.customer_id, o.id, ${JSON.stringify(input.lines)}::jsonb, o.total_minor,
               ${sellerSnapshot}::jsonb, o.ledger_transaction_id, ${buyerJson}::jsonb,
               coalesce(${issuedAtText}::timestamptz, now())
        from orders o
        where o.id = ${input.orderId} and o.customer_id = ${customerId}
          and o.total_minor = ${input.totalMinor.toString()}::bigint
        on conflict (order_id) do nothing`);
      if (inserted.rowCount !== 1) {
        const [order] = await tx
          .execute(
            sql`select total_minor from orders where id = ${input.orderId} and customer_id = ${customerId}`,
          )
          .then((r) => r.rows);
        return order === undefined ? refused("not_found") : refused("conflict");
      }
      const row = await byColumn(invoices.id, input.id);
      if (row === null) throw new Error("invoices: the inserted invoice cannot be read");
      return created(row);
    },

    // WPU-I2: the invoice of a renewal. The ledger transaction must be a renewal of a subscription of
    // this customer and the customer's wallet debit in it must be the total (R8, R16): anything else
    // inserts nothing. One invoice for each charge: the unique key on the ledger transaction (R7).
    issueForCharge: async (input) => {
      requireUuid(input.id, "id");
      requireUuid(input.ledgerTransactionId, "ledgerTransactionId");
      if (
        typeof input.totalMinor !== "bigint" ||
        input.totalMinor <= 0n ||
        !Number.isInteger(input.fiscalYear) ||
        input.fiscalYear < 2026 ||
        input.fiscalYear > 32000 ||
        !Array.isArray(input.lines) ||
        input.lines.length === 0 ||
        !validInstant(input.issuedAt) ||
        (input.buyer !== undefined && input.buyer !== null && !buyerValid(input.buyer))
      ) {
        return refused("validation");
      }
      const buyerJson = buyerJsonOf(input.buyer);
      const fiscalYear = input.fiscalYear;
      if (
        input.issuedAt !== undefined &&
        !(await fiscalYearMatches(tx, input.issuedAt, fiscalYear))
      ) {
        return refused("validation");
      }
      const issuedAtText = input.issuedAt === undefined ? null : input.issuedAt.toISOString();
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('invoice-number'), ${fiscalYear}::int)`,
      );
      const existing = await byColumn(invoices.ledgerTransactionId, input.ledgerTransactionId);
      if (existing !== null) {
        return existing.totalMinor === input.totalMinor ? replayed(existing) : refused("conflict");
      }
      const [owned] = await tx
        .execute<{ seller: unknown; debit: string; reversed: boolean }>(
          sql`select s.value as seller,
                     exists (select 1 from ledger_transactions r
                              where r.kind = 'reversal' and r.reference_type = 'ledger_transaction'
                                and r.reference_id = lt.id) as reversed,
                     (select coalesce(sum(e.amount_minor), 0)::text
                        from ledger_entries e join ledger_accounts a on a.id = e.account_id
                       where e.transaction_id = lt.id and a.type = 'customer_wallet'
                         and a.customer_id = ${customerId} and e.direction = 'debit') as debit
              from ledger_transactions lt
              join subscriptions sub on sub.id = lt.reference_id
              join resources r on r.id = sub.resource_id and r.customer_id = ${customerId}
              join customers c on c.id = r.customer_id
              left join settings s on s.market = c.market and s.key = ${INVOICE_SELLER_KEY} and s.scope = 'market'
              where lt.id = ${input.ledgerTransactionId} and lt.kind = 'renewal' and lt.reference_type = 'subscription'`,
        )
        .then((r) => r.rows);
      if (owned === undefined) return refused("not_found");
      if (BigInt(owned.debit) !== input.totalMinor) return refused("conflict");
      if (owned.reversed) return { ok: false, error: "charge_reversed" };
      const sellerNow = parseSellerRowValue(owned.seller);
      if (sellerNow === null) return { ok: false, error: "seller_details_missing" };
      const sellerSnapshot = JSON.stringify(sellerRowValueOf(sellerNow.seller, sellerNow.version));
      const inserted = await tx.execute(sql`
        insert into invoices (id, fiscal_year, number, customer_id, order_id, lines, total_minor, seller, ledger_transaction_id, buyer, issued_at)
        values (${input.id}, ${fiscalYear}::smallint,
               coalesce((select max(i.number) from invoices i where i.fiscal_year = ${fiscalYear}::smallint), 0) + 1,
               ${customerId}, null, ${JSON.stringify(input.lines)}::jsonb, ${input.totalMinor.toString()}::bigint,
               ${sellerSnapshot}::jsonb, ${input.ledgerTransactionId}, ${buyerJson}::jsonb,
               coalesce(${issuedAtText}::timestamptz, now()))
        on conflict (ledger_transaction_id) do nothing`);
      if (inserted.rowCount !== 1) return refused("conflict");
      const row = await byColumn(invoices.id, input.id);
      if (row === null) throw new Error("invoices: the inserted invoice cannot be read");
      return created(row);
    },

    queueBacklog: async (input) => {
      requireUuid(input.id, "id");
      requireUuid(input.ledgerTransactionId, "ledgerTransactionId");
      if (
        (input.kind !== "order" && input.kind !== "renewal") ||
        (input.kind === "order") !== (input.orderId !== undefined) ||
        (input.orderId !== undefined && !isUuid(input.orderId)) ||
        typeof input.totalMinor !== "bigint" ||
        input.totalMinor <= 0n ||
        !Array.isArray(input.lines) ||
        input.lines.length === 0
      ) {
        return refused("validation");
      }
      // The queue is a row of `discrepancies` (kind missing): web_rw may insert it and the admin queue
      // shows it. Ids, the amount and the lines only (R14). Only a charge of this customer is queued: the
      // ledger transaction has a wallet debit of the customer in it, of the amount (R8). web_rw cannot
      // read `discrepancies`, so the caller queues a charge once, when it makes the charge; the reader
      // takes one entry for each charge (invoiceBacklogRepo).
      const details = {
        source: INVOICE_BACKLOG_SOURCE,
        v: 1,
        charge: input.kind,
        customerId,
        ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
        ledgerTransactionId: input.ledgerTransactionId,
        totalMinor: input.totalMinor.toString(),
        lines: input.lines,
      };
      const inserted = await tx.execute(sql`
        insert into discrepancies (id, kind, details)
        select ${input.id}, 'missing', ${JSON.stringify(details)}::jsonb
        from ledger_transactions lt
        where lt.id = ${input.ledgerTransactionId}
          and exists (select 1 from ledger_entries e join ledger_accounts a on a.id = e.account_id
                       where e.transaction_id = lt.id and a.type = 'customer_wallet'
                         and a.customer_id = ${customerId} and e.direction = 'debit'
                         and e.amount_minor = ${input.totalMinor.toString()}::bigint)`);
      return inserted.rowCount === 1 ? created({ queued: true as const }) : refused("not_found");
    },

    backlogBlocked: async () => {
      const [row] = await tx
        .execute<{
          blocked: boolean;
        }>(sql`select invoice_backlog_blocked(${customerId}::uuid) as blocked`)
        .then((r) => r.rows);
      return row?.blocked === true;
    },

    noteUnrecorded: async (input) => {
      requireUuid(input.id, "id");
      requireUuid(input.ledgerTransactionId, "ledgerTransactionId");
      if (
        (input.kind !== "order" && input.kind !== "renewal") ||
        (input.kind === "order") !== (input.orderId !== undefined) ||
        (input.orderId !== undefined && !isUuid(input.orderId)) ||
        typeof input.totalMinor !== "bigint" ||
        input.totalMinor <= 0n
      ) {
        return refused("validation");
      }
      // Ids and the amount only (R14). Same ownership check as queueBacklog: the customer's own wallet
      // debit of that amount is in the ledger transaction.
      const details = {
        source: INVOICE_UNRECORDED_SOURCE,
        v: 1,
        charge: input.kind,
        customerId,
        ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
        ledgerTransactionId: input.ledgerTransactionId,
        totalMinor: input.totalMinor.toString(),
      };
      const inserted = await tx.execute(sql`
        insert into discrepancies (id, kind, details)
        select ${input.id}, 'missing', ${JSON.stringify(details)}::jsonb
        from ledger_transactions lt
        where lt.id = ${input.ledgerTransactionId}
          and exists (select 1 from ledger_entries e join ledger_accounts a on a.id = e.account_id
                       where e.transaction_id = lt.id and a.type = 'customer_wallet'
                         and a.customer_id = ${customerId} and e.direction = 'debit'
                         and e.amount_minor = ${input.totalMinor.toString()}::bigint)`);
      return inserted.rowCount === 1 ? created({ noted: true as const }) : refused("not_found");
    },
  };
}
