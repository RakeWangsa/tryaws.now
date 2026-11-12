import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isMarketCode } from "../config/args";
import {
  INVOICE_SELLER_KEY,
  parseSellerFields,
  parseSellerRowValue,
  sellerRowValueOf,
  type SellerRead,
  type SellerRow,
} from "../config/invoice-seller";
import { lockInvoiceSellerWrites } from "../config/locks";
import { INVOICE_BACKLOG_SOURCE } from "../customer/invoices";
import { refused, type Written } from "../result";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// /pricing/seller (WPU-I1): the legal details of the seller on the tax invoices (Mushak 6.3). `finance` and
// `superadmin`, the roles of the pricing area; the role check here is a second layer behind
// requireAdmin(roles) of the app (R9, R16). The write changes the setting `invoice_seller` (admin_rw
// already writes `settings`) through `audited` (R10): actor, reason, IP and target, with the before and
// after values in the same transaction. Each save raises `version`; the old values stay in the audit log.
// Nothing is seeded: the owner enters the values.
const ROLES: readonly AdminRole[] = ["finance", "superadmin"];

export interface InvoiceSellerInput {
  market: string;
  seller: SellerRow;
}

export interface InvoiceSellerSaved {
  market: string;
  version: number;
}

// WPU-I2: the charges of a market that wait for an invoice because the seller details were missing.
export interface InvoiceBacklogState {
  count: number;
  oldest: Date | null;
}

export interface InvoiceSellerAdminRepo {
  /** How many charges wait for an invoice in this market, and since when. */
  backlog(market: string): Promise<Written<InvoiceBacklogState>>;
  read(market: string): Promise<Written<SellerRead>>;
  save(input: InvoiceSellerInput, reason: string): Promise<Written<InvoiceSellerSaved>>;
}

const same = (a: SellerRow, b: SellerRow): boolean =>
  JSON.stringify(sellerRowValueOf(a, 1)) === JSON.stringify(sellerRowValueOf(b, 1));

export function invoiceSellerAdminRepo(scope: AdminScope): InvoiceSellerAdminRepo {
  const { role } = scope.actor;
  return {
    async backlog(market) {
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market)) return refused("validation");
      const found = await scope.tx.execute<{ n: string; oldest: Date | null }>(
        sql`select count(*)::text as n, min(q.created_at) as oldest from (
              select distinct on (d.details->>'ledgerTransactionId') d.created_at, d.details
              from discrepancies d
              where d.kind = 'missing' and d.details->>'source' = ${INVOICE_BACKLOG_SOURCE}
                and not exists (select 1 from invoices i
                                where i.ledger_transaction_id::text = d.details->>'ledgerTransactionId')
                -- WPU-I5: a charge that was reversed or whose row is closed by the scheduler is not owed
                and not exists (select 1 from discrepancies k
                                where k.details->>'source' = 'invoice_backlog_mark'
                                  and k.details->>'for' = d.id::text
                                  and k.details->>'state' in ('resolved', 'skipped'))
                and not exists (select 1 from ledger_transactions r
                                where r.kind = 'reversal' and r.reference_type = 'ledger_transaction'
                                  and r.reference_id::text = d.details->>'ledgerTransactionId')
              order by d.details->>'ledgerTransactionId', d.created_at) q
            join customers c on c.id::text = q.details->>'customerId'
            where c.market = ${market}`,
      );
      const row = found.rows[0];
      return {
        ok: true,
        value: {
          count: row === undefined ? 0 : Number(row.n),
          oldest: row?.oldest == null ? null : new Date(row.oldest),
        },
        replayed: false,
      };
    },

    async read(market) {
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market)) return refused("validation");
      const found = await scope.tx.execute<{ value: unknown }>(
        sql`select value from settings
            where key = ${INVOICE_SELLER_KEY} and market = ${market} and scope = 'market'`,
      );
      const row = found.rows[0];
      if (row === undefined) return { ok: true, value: { state: "none" }, replayed: false };
      const parsed = parseSellerRowValue(row.value);
      return {
        ok: true,
        value: parsed === null ? { state: "invalid" } : { state: "ok", ...parsed },
        replayed: false,
      };
    },

    async save(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, seller } = input;
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market)) return refused("validation");
      // Only the fields that are stored, so a request cannot add keys to the row.
      const checked = parseSellerFields(seller);
      if (checked === null) return refused("validation");
      const { tx, actor } = scope;
      return audited(
        scope,
        { action: "invoice_seller.save", targetType: "invoice_seller", targetId: market, reason },
        async () => {
          // Serializes the saves of one market: the read below sees every committed row.
          await lockInvoiceSellerWrites(tx, market);
          const existing = await tx.execute<{ id: string; value: unknown }>(
            sql`select id, value from settings
                where key = ${INVOICE_SELLER_KEY} and market = ${market} and scope = 'market'`,
          );
          const row = existing.rows[0];
          const current = row === undefined ? null : parseSellerRowValue(row.value);
          if (current !== null && same(current.seller, checked)) {
            return {
              value: { market, version: current.version },
              replayed: true,
              before: current.seller,
              after: current.seller,
            };
          }
          // A stored row that does not parse still holds a counter to continue from; the audit log keeps
          // the old value.
          const old =
            row !== undefined && typeof row.value === "object" && row.value !== null
              ? (row.value as Record<string, unknown>)["version"]
              : undefined;
          const last =
            current !== null
              ? current.version
              : typeof old === "number" && Number.isSafeInteger(old) && old > 0
                ? old
                : 0;
          const version = last + 1;
          const json = JSON.stringify(sellerRowValueOf(checked, version));
          // Only the granted columns: a Drizzle insert() would name created_at (42501).
          if (row === undefined) {
            await tx.execute(
              sql`insert into settings (id, key, market, scope, scope_id, value, set_by)
                  values (${uuidv7()}, ${INVOICE_SELLER_KEY}, ${market}, 'market', null, ${json}::jsonb, ${actor.adminId})`,
            );
          } else {
            await tx.execute(
              sql`update settings set value = ${json}::jsonb, set_by = ${actor.adminId}
                  where id = ${row.id}`,
            );
          }
          return {
            value: { market, version },
            replayed: false,
            before: current === null ? (row?.value ?? null) : current.seller,
            after: checked,
          };
        },
      );
    },
  };
}
