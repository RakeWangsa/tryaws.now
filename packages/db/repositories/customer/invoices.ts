import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { invoices } from "../../schema/index";
import { INVOICE_SELLER_KEY, parseSellerRowValue } from "../config/invoice-seller";
import { created, refused, replayed, type Written } from "../result";
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
}

export interface NewInvoice {
  id: string;
  orderId: string;
  // First calendar year of the fiscal year (fiscalYearOf of packages/core/invoices).
  fiscalYear: number;
  lines: readonly unknown[];
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
}

// WPU-I1: a tax invoice (Mushak 6.3) names its seller. Without complete seller details (the setting
// `invoice_seller` of the customer's market) nothing is issued and no number is taken (R16); the admin
// queue shows the notice.
export type IssueResult = Written<InvoiceRow> | { ok: false; error: "seller_details_missing" };

const INVOICE_COLUMNS = {
  id: invoices.id,
  fiscalYear: invoices.fiscalYear,
  number: invoices.number,
  orderId: invoices.orderId,
  lines: invoices.lines,
  totalMinor: invoices.totalMinor,
  issuedAt: invoices.issuedAt,
  pdfKey: invoices.pdfKey,
};

const toInvoice = (row: Record<keyof InvoiceRow, unknown>): InvoiceRow =>
  row as unknown as InvoiceRow;

function requireUuid(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !isUuid(value)) {
    // Fixed text: the refused value is never part of a message (R14).
    throw new TypeError(`invoices: ${what} is not a UUID`);
  }
}

export function invoicesRepo(scope: TenantScope): InvoicesRepo {
  const { tx, customerId } = scope;

  const byColumn = async (
    column: typeof invoices.id | typeof invoices.orderId,
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
        input.lines.length === 0
      ) {
        return refused("validation");
      }
      const fiscalYear = input.fiscalYear;
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
        .execute<{ seller: unknown }>(
          sql`select s.value as seller
              from orders o
              join customers c on c.id = o.customer_id
              left join settings s on s.market = c.market and s.key = ${INVOICE_SELLER_KEY} and s.scope = 'market'
              where o.id = ${input.orderId} and o.customer_id = ${customerId}`,
        )
        .then((r) => r.rows);
      if (owned === undefined) return refused("not_found");
      if (parseSellerRowValue(owned.seller) === null) {
        return { ok: false, error: "seller_details_missing" };
      }

      // The order is selected by id and customer in the same statement as the insert, and its total
      // must be the total of the invoice: an order of another customer, a missing one and a wrong
      // total insert nothing (R8, R16).
      const inserted = await tx.execute(sql`
        insert into invoices (id, fiscal_year, number, customer_id, order_id, lines, total_minor)
        select ${input.id}, ${fiscalYear}::smallint,
               coalesce((select max(i.number) from invoices i where i.fiscal_year = ${fiscalYear}::smallint), 0) + 1,
               o.customer_id, o.id, ${JSON.stringify(input.lines)}::jsonb, o.total_minor
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
  };
}
