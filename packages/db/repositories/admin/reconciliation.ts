import { sql, type SQL } from "drizzle-orm";
import { DISCREPANCY_KINDS, DISCREPANCY_STATUSES } from "../../schema/service";
import { refused, type Written } from "../result";
import { isUuid } from "../scope";
import { isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /reconciliation: the discrepancies by kind. These are reads. The one write of the screen,
// resolveDiscrepancy, is payments.resolveDiscrepancy of WP8-T3 (ops, finance, superadmin; through
// `audited`), so the screen has one write path and one audit action. The reader writes `details` as
// JSON; the screen shows only the keys of the allow-list, with short plain values: no AWS account id,
// no ARN, no raw error text (16.13, R14).
const READ_ROLES: readonly AdminRole[] = ["ops", "finance", "superadmin"];

export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];
export type DiscrepancyState = (typeof DISCREPANCY_STATUSES)[number];

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
const MAX_VALUE = 200;
// The order of the keys is the order of the screen.
export const DETAIL_KEYS = [
  "resourceId",
  "operationId",
  "paymentId",
  "transactionId",
  "customerId",
  "family",
  "region",
  "expectedMinor",
  "actualMinor",
  "gotMinor",
  "count",
  "note",
] as const;

export interface DetailEntry {
  key: string;
  value: string;
}

export interface ReconciliationRow {
  id: string;
  kind: DiscrepancyKind;
  status: DiscrepancyState;
  createdAt: Date;
  details: DetailEntry[];
}

export interface ReconciliationListInput {
  kind?: DiscrepancyKind;
  status?: DiscrepancyState;
  limit?: number;
  // The id of the last row of the page before.
  after?: string;
}

export interface ReconciliationListResult {
  rows: ReconciliationRow[];
  nextAfter: string | null;
}

// The open discrepancies of each kind.
export type ReconciliationOverview = Record<DiscrepancyKind, number>;

export interface ReconciliationAdminRepo {
  overview(): Promise<Written<ReconciliationOverview>>;
  list(input: ReconciliationListInput): Promise<Written<ReconciliationListResult>>;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 0x20) return true;
  return false;
}

function safeValue(value: unknown): string | null {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  else if (typeof value === "boolean") text = String(value);
  else return null;
  if (text === "" || text.length > MAX_VALUE || hasControlCharacter(text)) return null;
  // An ARN, an account id (12 digits) and a secret-looking token stay out of the screen.
  if (/arn:/i.test(text) || /(?<![0-9])[0-9]{12}(?![0-9])/.test(text)) return null;
  return text;
}

export function projectDetails(details: unknown): DetailEntry[] {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  const record = details as Record<string, unknown>;
  const out: DetailEntry[] = [];
  for (const key of DETAIL_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = safeValue(record[key]);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

function pageSize(limit: number | undefined): number | null {
  if (limit === undefined) return DEFAULT_PAGE;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE ? limit : null;
}

export function reconciliationAdminRepo(scope: AdminScope): ReconciliationAdminRepo {
  const canRead = READ_ROLES.includes(scope.actor.role);
  return {
    async overview() {
      if (!canRead || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { rows } = await scope.tx.execute<{ kind: string; n: string }>(
        sql`select kind, count(*) as n from discrepancies where status = 'open' group by kind`,
      );
      const value = Object.fromEntries(DISCREPANCY_KINDS.map((k) => [k, 0])) as Record<
        DiscrepancyKind,
        number
      >;
      for (const row of rows) {
        if ((DISCREPANCY_KINDS as readonly string[]).includes(row.kind)) {
          value[row.kind as DiscrepancyKind] = Number(row.n);
        }
      }
      return { ok: true, replayed: false, value };
    },

    async list(input) {
      if (!canRead || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { kind, status, limit, after } = input ?? {};
      const size = pageSize(limit);
      if (
        size === null ||
        (kind !== undefined && !(DISCREPANCY_KINDS as readonly string[]).includes(kind)) ||
        (status !== undefined && !(DISCREPANCY_STATUSES as readonly string[]).includes(status)) ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      const conditions: SQL[] = [sql`true`];
      if (kind !== undefined) conditions.push(sql`kind = ${kind}`);
      if (status !== undefined) conditions.push(sql`status = ${status}`);
      if (after !== undefined) conditions.push(sql`id < ${after}`);
      const result = await scope.tx.execute<{
        id: string;
        kind: string;
        status: string;
        details: unknown;
        created_at: Date;
      }>(
        sql`select id, kind, status, details, created_at from discrepancies
          where ${sql.join(conditions, sql` and `)} order by id desc limit ${size + 1}`,
      );
      const page = result.rows.slice(0, size);
      return {
        ok: true,
        replayed: false,
        value: {
          rows: page.map((r) => ({
            id: r.id,
            kind: r.kind as DiscrepancyKind,
            status: r.status as DiscrepancyState,
            createdAt: r.created_at,
            details: projectDetails(r.details),
          })),
          nextAfter: result.rows.length > size ? (page[page.length - 1]?.id ?? null) : null,
        },
      };
    },
  };
}
