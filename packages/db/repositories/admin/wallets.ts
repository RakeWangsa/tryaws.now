import { sql } from "drizzle-orm";
import { sumWalletEntries } from "../../ledger/accounts";
import { asText, toMinor } from "../../ledger/values";
import { ADJUSTMENT_DIRECTIONS, ADJUSTMENT_KINDS } from "../../schema/money";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";
import type { LedgerPoster, LedgerPostRequest } from "./ledger-port";

// 16.12 /wallets/[customerId]. `finance` creates an adjustment; a second `finance` or `superadmin`
// approves or rejects it; the requester never does (also the check wallet_adjustments_approver_check).
// Up to the limit an adjustment posts at once, above it waits as `pending` (9.1). The role check here
// is a second layer behind requireAdmin(roles) of the app (R9, R16). Every write goes through `audited`
// (R10); the posting is made by the poster the app passes (@tc/core postTransaction, R5), under the
// wallet lock, with a key derived from the request id (R7).
const READ_ROLES: readonly AdminRole[] = ["finance", "superadmin"];
const CREATE_ROLES: readonly AdminRole[] = ["finance"];
const DECIDE_ROLES: readonly AdminRole[] = ["finance", "superadmin"];

export const ADJUSTMENT_LIMIT_KEY = "wallet.adjustment_limit_minor";
const MAX_MINOR = 9223372036854775807n;
const MAX_EVIDENCE = 200;
// Four-eyes rule against splitting: adjustments of one wallet that posted at once without a second
// admin count together over this window; the one that crosses the limit waits for a second admin.
export const SPLIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
const LIST_ROWS = 50;
// "<epoch microseconds>.<entry id>", the cursor of the customer statement.
const CURSOR = /^([0-9]{10,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const WHOLE_NUMBER = /^(0|[1-9][0-9]{0,17})$/;

export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export interface AdjustmentRow {
  id: string;
  customerId: string;
  direction: AdjustmentDirection;
  amountMinor: bigint;
  kind: AdjustmentKind;
  reason: string;
  evidenceRef: string | null;
  requestedBy: string;
  approvedBy: string | null;
  status: "pending" | "approved" | "rejected";
  ledgerTransactionId: string | null;
  createdAt: Date;
}

export interface WalletLedgerLine {
  entryId: string;
  transactionId: string;
  createdAt: Date;
  kind: string;
  referenceType: string;
  // On the customer's wallet account: credit is money in.
  direction: "credit" | "debit";
  amountMinor: bigint;
  // Running sum of the account in (created_at, id) order, over the whole history.
  balanceAfterMinor: bigint;
}

export interface WalletAdminDetail {
  customerId: string;
  currency: string;
  // The cache wallets.balance_minor and the sum of the ledger lines; `consistent` is false when they differ.
  balanceMinor: bigint;
  ledgerSumMinor: bigint | null;
  consistent: boolean;
  // Adjustments up to this amount post at once; 0 when none is set (everything waits, R16).
  limitMinor: bigint;
  lines: WalletLedgerLine[];
  nextCursor: string | null;
  pending: AdjustmentRow[];
  decided: AdjustmentRow[];
}

export interface WalletDetailOptions {
  limit?: number;
  cursor?: string;
}

export interface AdjustmentInput {
  // Made when the form is rendered; the id of the row and the source of the ledger key (R7).
  requestId: string;
  customerId: string;
  direction: AdjustmentDirection;
  amountMinor: bigint;
  kind: AdjustmentKind;
  evidenceRef?: string;
  // The caller clock reading: the end of the window of the split rule (never the database clock).
  at: Date;
}

export interface AdjustmentDecisionInput {
  id: string;
}

export interface AdjustmentChanged {
  id: string;
  customerId: string;
  status: AdjustmentRow["status"];
  ledgerTransactionId: string | null;
}

export interface WalletsAdminRepo {
  detail(customerId: string, options?: WalletDetailOptions): Promise<Written<WalletAdminDetail>>;
  createAdjustment(
    input: AdjustmentInput,
    reason: string,
    post: LedgerPoster,
  ): Promise<Written<AdjustmentChanged>>;
  approveAdjustment(
    input: AdjustmentDecisionInput,
    reason: string,
    post: LedgerPoster,
  ): Promise<Written<AdjustmentChanged>>;
  rejectAdjustment(
    input: AdjustmentDecisionInput,
    reason: string,
  ): Promise<Written<AdjustmentChanged>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: RepoErrorCode) {
    super("wallet action refused");
  }
}

type AdjustmentDbRow = {
  id: string;
  customer_id: string;
  direction: string;
  amount_minor: string;
  kind: string;
  reason: string;
  evidence_ref: string | null;
  requested_by: string;
  approved_by: string | null;
  status: string;
  ledger_transaction_id: string | null;
  created_at: Date;
};

const ADJUSTMENT_COLUMNS = sql`id, customer_id, direction, amount_minor::text as amount_minor, kind, reason, evidence_ref, requested_by, approved_by, status, ledger_transaction_id, created_at`;

const toAdjustment = (r: AdjustmentDbRow): AdjustmentRow => ({
  id: r.id,
  customerId: r.customer_id,
  direction: r.direction as AdjustmentDirection,
  amountMinor: BigInt(r.amount_minor),
  kind: r.kind as AdjustmentKind,
  reason: r.reason,
  evidenceRef: r.evidence_ref,
  requestedBy: r.requested_by,
  approvedBy: r.approved_by,
  status: r.status as AdjustmentRow["status"],
  ledgerTransactionId: r.ledger_transaction_id,
  createdAt: r.created_at,
});

const changed = (r: AdjustmentDbRow, over: Partial<AdjustmentChanged> = {}): AdjustmentChanged => ({
  id: r.id,
  customerId: r.customer_id,
  status: r.status as AdjustmentRow["status"],
  ledgerTransactionId: r.ledger_transaction_id,
  ...over,
});

const isAmount = (value: unknown): value is bigint =>
  typeof value === "bigint" && value > 0n && value <= MAX_MINOR;

// The two lines of 9.1: a credit takes the money from `adjustments`, a debit gives it back.
function postingOf(
  adjustmentId: string,
  customerId: string,
  direction: AdjustmentDirection,
  amountMinor: bigint,
  adminId: string,
  reason: string,
): LedgerPostRequest {
  const wallet = { type: "customer_wallet", customerId } as const;
  const platform = { type: "adjustments" } as const;
  return {
    kind: "adjustment",
    reference: { type: "wallet_adjustment", id: adjustmentId },
    idempotencyKey: `adjustment:${adjustmentId}`,
    actor: { type: "admin", id: adminId },
    memo: reason,
    postings:
      direction === "credit"
        ? [
            { account: platform, direction: "debit", amountMinor },
            { account: wallet, direction: "credit", amountMinor },
          ]
        : [
            { account: wallet, direction: "debit", amountMinor },
            { account: platform, direction: "credit", amountMinor },
          ],
  };
}

export function walletsAdminRepo(scope: AdminScope): WalletsAdminRepo {
  const role = scope.actor.role;
  const { tx, actor } = scope;

  // The limit of the market of the customer: a whole number of paisa as JSON text or number; anything
  // else (missing, a fraction, negative, text) counts as 0, so every adjustment waits (R16).
  const limitOf = async (customerId: string): Promise<bigint> => {
    const { rows } = await tx.execute<{ v: string | null }>(
      sql`select s.value #>> '{}' as v from settings s join customers c on c.market = s.market
           where c.id = ${customerId} and s.key = ${ADJUSTMENT_LIMIT_KEY} and s.scope = 'market'`,
    );
    const text = rows[0]?.v;
    return typeof text === "string" && WHOLE_NUMBER.test(text) ? BigInt(text) : 0n;
  };

  const readAdjustment = async (id: string, lock: boolean): Promise<AdjustmentDbRow | null> => {
    const { rows } = await tx.execute<AdjustmentDbRow>(
      lock
        ? sql`select ${ADJUSTMENT_COLUMNS} from wallet_adjustments where id = ${id} for update`
        : sql`select ${ADJUSTMENT_COLUMNS} from wallet_adjustments where id = ${id}`,
    );
    return rows[0] ?? null;
  };

  const decide = async (
    action: "wallet.adjustment.approve" | "wallet.adjustment.reject",
    input: AdjustmentDecisionInput,
    reason: string,
    post: LedgerPoster | null,
  ): Promise<Written<AdjustmentChanged>> => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const id = input?.id;
    if (!DECIDE_ROLES.includes(role)) return refused("forbidden");
    if (typeof id !== "string" || !isUuid(id)) return refused("validation");
    if (post !== null && typeof post !== "function") return refused("validation");
    const approving = post !== null;
    const note = typeof reason === "string" ? reason.trim() : "";
    try {
      return await audited(
        scope,
        { action, targetType: "wallet_adjustment", targetId: id, reason: note },
        async () => {
          const row = await readAdjustment(id, true);
          if (row === null) throw new Refusal("not_found");
          const meta = { customerId: row.customer_id, amountMinor: row.amount_minor };
          const target = approving ? "approved" : "rejected";
          // The same decision again is a replay: by the same approver for an approval (R7).
          if (row.status === target) {
            if (approving && row.approved_by !== actor.adminId) throw new Refusal("conflict");
            return {
              value: changed(row),
              replayed: true,
              before: { ...meta, status: row.status },
              after: { ...meta, status: row.status },
            };
          }
          if (row.status !== "pending") throw new Refusal("conflict");
          // A second admin decides: the requester never does (R10).
          if (row.requested_by === actor.adminId) throw new Refusal("forbidden");
          let ledgerTransactionId: string | null = null;
          if (approving) {
            const posted = await post(
              tx,
              postingOf(
                row.id,
                row.customer_id,
                row.direction as AdjustmentDirection,
                BigInt(row.amount_minor),
                actor.adminId,
                row.reason,
              ),
            );
            // A refused posting wrote nothing (core refuses before its first insert); the request stays pending.
            if (!posted.ok) throw new Refusal("conflict");
            ledgerTransactionId = posted.value.transactionId;
            await tx.execute(
              sql`update wallet_adjustments set status = 'approved', approved_by = ${actor.adminId}, ledger_transaction_id = ${ledgerTransactionId} where id = ${row.id}`,
            );
          } else {
            await tx.execute(
              sql`update wallet_adjustments set status = 'rejected' where id = ${row.id}`,
            );
          }
          return {
            value: changed(row, { status: target, ledgerTransactionId }),
            replayed: false,
            before: { ...meta, status: "pending" },
            after: { ...meta, status: target, ledgerTransactionId },
          };
        },
      );
    } catch (error) {
      if (error instanceof Refusal) return refused(error.code);
      throw error;
    }
  };

  return {
    async detail(customerId, options) {
      if (!READ_ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (typeof customerId !== "string" || !isUuid(customerId)) return refused("not_found");
      const limit = options?.limit ?? DEFAULT_PAGE;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return refused("validation");
      const wallet = await tx.execute<{ id: string; currency: string; balance_minor: string }>(
        sql`select id, currency, balance_minor::text as balance_minor from wallets where customer_id = ${customerId}`,
      );
      const walletRow = wallet.rows[0];
      if (walletRow === undefined) return refused("not_found");

      let after: { micros: string; entryId: string } | null = null;
      let emptyPage = false;
      if (options?.cursor !== undefined) {
        const match = typeof options.cursor === "string" ? CURSOR.exec(options.cursor) : null;
        const micros = match?.[1];
        const entryId = match?.[2];
        if (micros === undefined || entryId === undefined) emptyPage = true;
        else after = { micros, entryId };
      }
      const afterFilter =
        after === null
          ? sql``
          : sql`where (l."cursorMicros", l."entryId") < (${after.micros}::bigint, ${after.entryId}::uuid)`;
      // The running sum is computed over the whole history of the account, then the page is cut.
      // The free-text memo of the transaction is not selected.
      const lines = emptyPage
        ? { rows: [] as Record<string, unknown>[] }
        : await tx.execute<Record<string, unknown>>(sql`
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
      const page = lines.rows.slice(0, limit);
      const last = page[page.length - 1];
      const pending = await tx.execute<AdjustmentDbRow>(
        sql`select ${ADJUSTMENT_COLUMNS} from wallet_adjustments where customer_id = ${customerId} and status = 'pending' order by created_at, id limit ${LIST_ROWS}`,
      );
      const decided = await tx.execute<AdjustmentDbRow>(
        sql`select ${ADJUSTMENT_COLUMNS} from wallet_adjustments where customer_id = ${customerId} and status <> 'pending' order by created_at desc, id desc limit ${LIST_ROWS}`,
      );
      const balanceMinor = BigInt(walletRow.balance_minor);
      const ledgerSumMinor = await sumWalletEntries(tx, walletRow.id);
      return {
        ok: true,
        replayed: false,
        value: {
          customerId,
          currency: walletRow.currency,
          balanceMinor,
          ledgerSumMinor,
          consistent: ledgerSumMinor === balanceMinor,
          limitMinor: await limitOf(customerId),
          lines: page.map((row) => ({
            entryId: asText(row["entryId"]),
            transactionId: asText(row["transactionId"]),
            createdAt: new Date(asText(row["createdAt"])),
            kind: asText(row["kind"]),
            referenceType: asText(row["referenceType"]),
            direction: row["direction"] === "credit" ? "credit" : "debit",
            amountMinor: toMinor(row["amountMinor"]),
            balanceAfterMinor: toMinor(row["balanceAfterMinor"]),
          })),
          nextCursor:
            lines.rows.length > limit && last !== undefined
              ? `${asText(last["cursorMicros"])}.${asText(last["entryId"])}`
              : null,
          pending: pending.rows.map(toAdjustment),
          decided: decided.rows.map(toAdjustment),
        },
      };
    },

    async createAdjustment(input, reason, post) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { requestId, customerId, direction, amountMinor, kind, evidenceRef, at } = input ?? {};
      if (!CREATE_ROLES.includes(role)) return refused("forbidden");
      if (
        typeof requestId !== "string" ||
        !isUuid(requestId) ||
        typeof customerId !== "string" ||
        !isUuid(customerId) ||
        !(ADJUSTMENT_DIRECTIONS as readonly unknown[]).includes(direction) ||
        !(ADJUSTMENT_KINDS as readonly unknown[]).includes(kind) ||
        !isAmount(amountMinor) ||
        (evidenceRef !== undefined &&
          (typeof evidenceRef !== "string" ||
            evidenceRef.trim() === "" ||
            evidenceRef.length > MAX_EVIDENCE)) ||
        !(at instanceof Date) ||
        Number.isNaN(at.getTime()) ||
        typeof post !== "function"
      ) {
        return refused("validation");
      }
      const id = requestId.toLowerCase();
      const customer = customerId.toLowerCase();
      const dir = direction as AdjustmentDirection;
      const note = typeof reason === "string" ? reason.trim() : "";
      try {
        return await audited(
          scope,
          {
            action: "wallet.adjustment.create",
            targetType: "wallet_adjustment",
            targetId: id,
            reason: note,
          },
          async () => {
            // Two overlapping submits of one request meet here; the second reads the first one's row.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${"wallet_adjustment:" + id}, 0))`,
            );
            const meta = {
              customerId: customer,
              direction: dir,
              amountMinor: amountMinor.toString(),
              kind,
            };
            const existing = await readAdjustment(id, false);
            if (existing !== null) {
              const same =
                existing.customer_id === customer &&
                existing.direction === dir &&
                existing.amount_minor === amountMinor.toString() &&
                existing.kind === kind &&
                existing.requested_by === actor.adminId &&
                existing.reason === note &&
                existing.evidence_ref === (evidenceRef?.trim() ?? null);
              if (!same) throw new Refusal("conflict");
              return {
                value: changed(existing),
                replayed: true,
                before: { ...meta, status: existing.status },
                after: { ...meta, status: existing.status },
              };
            }
            // The wallet lock comes first (the one the ledger takes): requests of one wallet are
            // counted one after the other, so two of them cannot both pass the limit.
            const found = await tx.execute<{ id: string }>(
              sql`select id from wallets where customer_id = ${customer} for update`,
            );
            if (found.rows[0] === undefined) throw new Refusal("not_found");
            // What posted without a second admin in the window counts together (no splitting).
            const since = new Date(at.getTime() - SPLIT_WINDOW_MS);
            const recent = await tx.execute<{ total: string }>(
              sql`select coalesce(sum(amount_minor), 0)::text as total from wallet_adjustments
                   where customer_id = ${customer} and status = 'approved' and approved_by is null
                     and created_at > ${since}`,
            );
            const already = BigInt(recent.rows[0]?.total ?? "0");
            // Up to the limit it posts now; above it waits for a second admin (9.1).
            const immediate = amountMinor + already <= (await limitOf(customer));
            let ledgerTransactionId: string | null = null;
            if (immediate) {
              const posted = await post(
                tx,
                postingOf(id, customer, dir, amountMinor, actor.adminId, note),
              );
              // A refused posting wrote nothing, so no row is left behind (for example an uncovered debit).
              if (!posted.ok) throw new Refusal("conflict");
              ledgerTransactionId = posted.value.transactionId;
            }
            const status = immediate ? "approved" : "pending";
            // Only the granted columns (migration 0006): a Drizzle insert() would name created_at.
            await tx.execute(
              sql`insert into wallet_adjustments (id, customer_id, direction, amount_minor, kind, reason, evidence_ref, requested_by, status, ledger_transaction_id)
                  values (${id}, ${customer}, ${dir}, ${amountMinor}::bigint, ${kind}, ${note}, ${evidenceRef?.trim() ?? null}, ${actor.adminId}, ${status}, ${ledgerTransactionId})`,
            );
            return {
              value: { id, customerId: customer, status, ledgerTransactionId } as AdjustmentChanged,
              replayed: false,
              before: null,
              after: { ...meta, status, ledgerTransactionId },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    approveAdjustment: (input, reason, post) =>
      decide("wallet.adjustment.approve", input, reason, post),
    rejectAdjustment: (input, reason) => decide("wallet.adjustment.reject", input, reason, null),
  };
}
