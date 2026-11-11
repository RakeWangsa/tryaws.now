import { sql, type SQL } from "drizzle-orm";
import { AUDIT_ACTOR_TYPES } from "../../schema/service";
import { refused, type Written } from "../result";
import { isUuid } from "../scope";
import { isActiveAdmin } from "./audited";
import { maskEmail, maskPhone } from "./customers";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /audit: search the audit log. READ ONLY, by construction: this repository has no method that
// writes, and the grants of admin_rw for audit_log are SELECT and INSERT (append-only, triggers of
// 0005). Every read begins with the role check and the active-admin check (H1, R16). Whatever leaves
// this file is masked (R14): the screen and the export cannot show a password, token, secret, document
// number, full phone number or email even when an older row holds one.
const READ_ROLES: readonly AdminRole[] = ["support", "finance", "ops", "superadmin"];
const EXPORT_ROLES: readonly AdminRole[] = ["superadmin"];

export const AUDIT_PAGE_DEFAULT = 25;
export const AUDIT_PAGE_MAX = 100;
// The hard cap of one export (rows). A bigger view is cut and says so.
export const AUDIT_EXPORT_CAP = 5000;

const MAX_ACTION = 80;
const MAX_TARGET_ID = 100;
const TARGET_TYPE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_DEPTH = 4;
const MAX_ITEMS = 20;
const MAX_TEXT = 200;
const MAX_KEYS = 40;

export interface AuditFilter {
  actorId?: string;
  actorType?: (typeof AUDIT_ACTOR_TYPES)[number];
  targetType?: string;
  // The exact target id, or the id of a domain name; no wildcard.
  targetId?: string;
  // An exact action, or a prefix when it ends with a dot ("payment.").
  action?: string;
  from?: Date;
  // Exclusive.
  to?: Date;
}

export interface AuditSearchInput extends AuditFilter {
  limit?: number;
  after?: string;
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  // The reason of R10, masked, null when the row has none.
  reason: string | null;
  before: unknown;
  after: unknown;
  // The other keys of the metadata, masked.
  extra: Record<string, unknown>;
}

export interface AuditSearchResult {
  rows: AuditRow[];
  nextAfter: string | null;
}

export interface AuditExportResult {
  rows: AuditRow[];
  truncated: boolean;
}

export interface AuditAdminRepo {
  search(input?: AuditSearchInput): Promise<Written<AuditSearchResult>>;
  detail(id: string): Promise<Written<AuditRow>>;
  // `options.cap` is for tests and for a smaller export; it can never exceed AUDIT_EXPORT_CAP.
  export(filter?: AuditFilter, options?: { cap?: number }): Promise<Written<AuditExportResult>>;
}

type AuditDbRow = {
  id: string;
  created_at: Date;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: unknown;
};

const COLUMNS = sql`id, created_at, actor_type, actor_id, action, target_type, target_id, host(ip) as ip, user_agent, metadata`;

// Keys whose value is never shown, whatever it is.
const SECRET_KEY =
  /pass(word|wd)?|token|secret|otp|pin\b|code|authorization|cookie|credential|private|api[_-]?key|access[_-]?key|(^|[_-])key($|[_-])|document|national[_-]?id|passport|licen[cs]e|signature|verify[_-]?payload/i;
const NID_KEY = /(^|[^a-z])nid([^a-z]|$)/i;
const PHONE_KEY = /phone|mobile|msisdn/i;
const EMAIL_KEY = /e[-_]?mail/i;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A run of 10 to 15 digits that is not part of a longer word or of an id with dashes.
const PHONE_IN_TEXT = /(?<![\w-])\+?\d{10,15}(?![\w-])/g;
const MASKED = "[masked]";

function maskText(text: string): string {
  const replaced = text
    .replace(EMAIL_IN_TEXT, (m) => maskEmail(m))
    .replace(PHONE_IN_TEXT, (m) => maskPhone(m.replace(/[\s-]/g, "")));
  return replaced.length > MAX_TEXT ? `${replaced.slice(0, MAX_TEXT)}…` : replaced;
}

function maskValue(key: string, value: unknown, depth: number): unknown {
  if (SECRET_KEY.test(key) || NID_KEY.test(key)) return MASKED;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (EMAIL_KEY.test(key) && value.includes("@")) return maskEmail(value);
    if (PHONE_KEY.test(key)) return maskPhone(value.replace(/[\s-]/g, ""));
    return maskText(value);
  }
  if (depth >= MAX_DEPTH) return MASKED;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => maskValue(key, item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS)) {
      out[k.slice(0, 60)] = maskValue(k, v, depth + 1);
    }
    return out;
  }
  return MASKED;
}

function toRow(r: AuditDbRow): AuditRow {
  const meta =
    typeof r.metadata === "object" && r.metadata !== null && !Array.isArray(r.metadata)
      ? (r.metadata as Record<string, unknown>)
      : {};
  const { reason, before, after, ...rest } = meta;
  return {
    id: r.id,
    createdAt: r.created_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    ip: r.ip,
    userAgent: r.user_agent === null ? null : maskText(r.user_agent),
    reason: typeof reason === "string" ? maskText(reason) : null,
    before: before === undefined ? null : maskValue("before", before, 1),
    after: after === undefined ? null : maskValue("after", after, 1),
    extra: maskValue("extra", rest, 1) as Record<string, unknown>,
  };
}

const sizeOf = (limit: number | undefined): number | null => {
  if (limit === undefined) return AUDIT_PAGE_DEFAULT;
  return Number.isInteger(limit) && limit >= 1 && limit <= AUDIT_PAGE_MAX ? limit : null;
};

const validDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

// The WHERE of a filter, or null when an input is not valid.
function whereOf(filter: AuditFilter | undefined): SQL[] | null {
  const f = filter ?? {};
  const { actorId, actorType, targetType, targetId, action, from, to } = f;
  if (
    (actorId !== undefined && (typeof actorId !== "string" || !isUuid(actorId))) ||
    (actorType !== undefined && !(AUDIT_ACTOR_TYPES as readonly unknown[]).includes(actorType)) ||
    (targetType !== undefined &&
      (typeof targetType !== "string" || !TARGET_TYPE.test(targetType))) ||
    (targetId !== undefined &&
      (typeof targetId !== "string" || targetId === "" || targetId.length > MAX_TARGET_ID)) ||
    (action !== undefined &&
      (typeof action !== "string" || action === "" || action.length > MAX_ACTION)) ||
    (from !== undefined && !validDate(from)) ||
    (to !== undefined && !validDate(to)) ||
    (from !== undefined && to !== undefined && from.getTime() >= to.getTime())
  ) {
    return null;
  }
  const where: SQL[] = [sql`true`];
  if (actorId !== undefined) where.push(sql`actor_id = ${actorId.toLowerCase()}`);
  if (actorType !== undefined) where.push(sql`actor_type = ${actorType}`);
  if (targetType !== undefined) where.push(sql`target_type = ${targetType}`);
  if (targetId !== undefined) where.push(sql`target_id = ${targetId}`);
  if (action !== undefined) {
    where.push(
      action.endsWith(".") ? sql`starts_with(action, ${action})` : sql`action = ${action}`,
    );
  }
  if (from !== undefined) where.push(sql`created_at >= ${from.toISOString()}::timestamptz`);
  if (to !== undefined) where.push(sql`created_at < ${to.toISOString()}::timestamptz`);
  return where;
}

export function auditAdminRepo(scope: AdminScope): AuditAdminRepo {
  const role = scope.actor.role;
  const { tx } = scope;

  return {
    async search(input) {
      if (!READ_ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { limit, after, ...filter } = input ?? {};
      const size = sizeOf(limit);
      const where = whereOf(filter);
      if (
        size === null ||
        where === null ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      if (after !== undefined) where.push(sql`id < ${after.toLowerCase()}`);
      const result = await tx.execute<AuditDbRow>(
        sql`select ${COLUMNS} from audit_log where ${sql.join(where, sql` and `)} order by id desc limit ${size + 1}`,
      );
      const page = result.rows.slice(0, size);
      return {
        ok: true,
        replayed: false,
        value: {
          rows: page.map(toRow),
          nextAfter: result.rows.length > size ? (page[page.length - 1]?.id ?? null) : null,
        },
      };
    },

    async detail(id) {
      if (!READ_ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (typeof id !== "string" || !isUuid(id)) return refused("not_found");
      const result = await tx.execute<AuditDbRow>(
        sql`select ${COLUMNS} from audit_log where id = ${id.toLowerCase()}`,
      );
      const row = result.rows[0];
      if (row === undefined) return refused("not_found");
      return { ok: true, replayed: false, value: toRow(row) };
    },

    async export(filter, options) {
      if (!EXPORT_ROLES.includes(role) || !(await isActiveAdmin(scope)))
        return refused("forbidden");
      const cap = options?.cap ?? AUDIT_EXPORT_CAP;
      const where = whereOf(filter);
      if (where === null || !Number.isInteger(cap) || cap < 1 || cap > AUDIT_EXPORT_CAP) {
        return refused("validation");
      }
      const result = await tx.execute<AuditDbRow>(
        sql`select ${COLUMNS} from audit_log where ${sql.join(where, sql` and `)} order by id desc limit ${cap + 1}`,
      );
      return {
        ok: true,
        replayed: false,
        value: { rows: result.rows.slice(0, cap).map(toRow), truncated: result.rows.length > cap },
      };
    },
  };
}
