import { sql } from "drizzle-orm";
import { asText, toMinor } from "../../ledger/values";
import { isUuid, type TenantScope } from "../scope";

// The customer's view of the wallet (R8: the customer is the one of the scope, no method takes a
// customer id). Reads only; the wallet is written by @tc/eps and @tc/core through the ledger.
export interface WalletView {
  balanceMinor: bigint;
  currency: string;
}

export interface StatementLine {
  entryId: string;
  transactionId: string;
  createdAt: Date;
  // ledger_transactions.kind. The free-text column of the transaction is never selected: it may
  // hold staff text.
  kind: string;
  referenceType: string;
  // On the customer's wallet account: credit is money in.
  direction: "credit" | "debit";
  amountMinor: bigint;
  // Running sum of the account in (created_at, id) order, over the whole history.
  balanceAfterMinor: bigint;
}

export interface StatementPage {
  lines: StatementLine[];
  nextCursor: string | null;
}

export interface WalletRepo {
  // The wallets row of the scope's customer, or null when there is none.
  view(): Promise<WalletView | null>;
  // Newest first. limit is an integer from 1 to 100, else TypeError. An invalid cursor gives an
  // empty page with nextCursor null.
  statement(opts: { limit: number; cursor?: string }): Promise<StatementPage>;
}

// "<epoch microseconds>.<entry id>": microseconds because timestamptz has them, so that two lines
// of one millisecond are neither skipped nor repeated between pages.
const CURSOR = /^([0-9]{10,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const asDirection = (value: unknown): "credit" | "debit" => {
  if (value === "credit" || value === "debit") return value;
  throw new TypeError("wallet: not a ledger direction");
};

export function walletRepo(scope: TenantScope): WalletRepo {
  const { tx, customerId } = scope;

  return {
    view: async () => {
      const { rows } = await tx.execute<Record<string, unknown>>(sql`
        select w.balance_minor::text as "balanceMinor", w.currency as "currency"
          from wallets w
         where w.customer_id = ${customerId}`);
      const [row] = rows;
      if (row === undefined) return null;
      return { balanceMinor: toMinor(row.balanceMinor), currency: asText(row.currency) };
    },

    statement: async (opts) => {
      const { limit, cursor } = opts;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("wallet.statement: the limit is an integer from 1 to 100");
      }
      const empty: StatementPage = { lines: [], nextCursor: null };
      let after: { micros: string; entryId: string } | null = null;
      if (cursor !== undefined) {
        const match = typeof cursor === "string" ? CURSOR.exec(cursor) : null;
        const micros = match?.[1];
        const entryId = match?.[2];
        if (micros === undefined || entryId === undefined || !isUuid(entryId)) return empty;
        after = { micros, entryId };
      }
      const afterFilter =
        after === null
          ? sql``
          : sql`where (l."cursorMicros", l."entryId") < (${after.micros}::bigint, ${after.entryId}::uuid)`;

      // The running sum is computed over the whole history of the account in the CTE, then the page
      // is cut: a later page keeps the sum of the older lines. Fixed text only; amounts are text.
      const { rows } = await tx.execute<Record<string, unknown>>(sql`
        with l as (
          select e.id as "entryId",
                 e.transaction_id as "transactionId",
                 e.created_at as "createdAt",
                 floor(extract(epoch from e.created_at) * 1000000)::bigint as "cursorMicros",
                 t.kind as "kind",
                 t.reference_type as "referenceType",
                 e.direction as "direction",
                 e.amount_minor::text as "amountMinor",
                 sum(case when e.direction = 'credit' then e.amount_minor else -e.amount_minor end)
                   over (partition by e.account_id order by e.created_at, e.id)::text
                   as "balanceAfterMinor"
            from ledger_entries e
            join ledger_accounts a
              on a.id = e.account_id and a.type = 'customer_wallet' and a.customer_id = ${customerId}
            join ledger_transactions t on t.id = e.transaction_id
        )
        select l."entryId", l."transactionId", l."createdAt", l."cursorMicros"::text as "cursorMicros",
               l."kind", l."referenceType", l."direction", l."amountMinor", l."balanceAfterMinor"
          from l
          ${afterFilter}
         order by l."cursorMicros" desc, l."entryId" desc
         limit ${limit + 1}`);

      const page = rows.slice(0, limit);
      const lines: StatementLine[] = page.map((row) => ({
        entryId: asText(row.entryId),
        transactionId: asText(row.transactionId),
        createdAt: new Date(asText(row.createdAt)),
        kind: asText(row.kind),
        referenceType: asText(row.referenceType),
        direction: asDirection(row.direction),
        amountMinor: toMinor(row.amountMinor),
        balanceAfterMinor: toMinor(row.balanceAfterMinor),
      }));
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last !== undefined
          ? `${asText(last.cursorMicros)}.${asText(last.entryId)}`
          : null;
      return { lines, nextCursor };
    },
  };
}
