import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { CASE_STATUSES } from "../../schema/service";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import { maskEmail } from "./customers";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /support: the support requests, replyByEmail and closeRequest. The roles column of 16.12 says
// `support`; `superadmin` owns every area (6.2). The role check here is a second layer behind
// requireAdmin(roles) (R9, R16). Every write goes through `audited` (R10). The address of a requester
// never leaves this file unmasked (R14); the text of a reply goes to the notification and not into the
// audit row.
const ROLES: readonly AdminRole[] = ["support", "superadmin"];

const MAX_BODY = 5000;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
const AUDIT_LIMIT = 30;
export const SUPPORT_REPLY_TEMPLATE = "support_reply";

export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface SupportListInput {
  status?: CaseStatus;
  limit?: number;
  // The id of the last row of the page before.
  after?: string;
}

export interface SupportRequestRow {
  id: string;
  customerId: string | null;
  name: string | null;
  emailMasked: string | null;
  category: string;
  subject: string;
  status: CaseStatus;
  relatedResourceId: string | null;
  handledBy: string | null;
  createdAt: Date;
}

export interface SupportListResult {
  rows: SupportRequestRow[];
  nextAfter: string | null;
}

export interface SupportTrailRow {
  id: string;
  action: string;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface SupportRequestDetail extends SupportRequestRow {
  message: string;
  audit: SupportTrailRow[];
}

export interface SupportReplyInput {
  requestId: string;
  // The idempotency key of the reply (R7): the form carries it, a second submit is a replay.
  replyId: string;
  body: string;
}

export interface SupportReplied {
  requestId: string;
  replyId: string;
}

export interface SupportCloseInput {
  requestId: string;
}

export interface SupportClosed {
  requestId: string;
  status: CaseStatus;
}

export interface SupportAdminRepo {
  list(input: SupportListInput): Promise<Written<SupportListResult>>;
  detail(requestId: string): Promise<Written<SupportRequestDetail>>;
  reply(input: SupportReplyInput, reason: string): Promise<Written<SupportReplied>>;
  close(input: SupportCloseInput, reason: string): Promise<Written<SupportClosed>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: RepoErrorCode) {
    super("support action refused");
  }
}

type RequestDbRow = {
  id: string;
  customer_id: string | null;
  name: string | null;
  email: string | null;
  customer_email: string | null;
  category: string;
  subject: string;
  status: string;
  related_resource_id: string | null;
  handled_by: string | null;
  created_at: Date;
};

const SELECT_REQUEST = sql`select s.id, s.customer_id, coalesce(s.name, c.name) as name, s.email,
  c.email as customer_email, s.category, s.subject, s.status, s.related_resource_id, s.handled_by,
  s.created_at
  from support_requests s left join customers c on c.id = s.customer_id`;

const toRow = (r: RequestDbRow): SupportRequestRow => {
  const address = r.customer_email ?? r.email;
  return {
    id: r.id,
    customerId: r.customer_id,
    name: r.name,
    emailMasked: address === null ? null : maskEmail(address),
    category: r.category,
    subject: r.subject,
    status: r.status as CaseStatus,
    relatedResourceId: r.related_resource_id,
    handledBy: r.handled_by,
    createdAt: r.created_at,
  };
};

function pageSize(limit: number | undefined): number | null {
  if (limit === undefined) return DEFAULT_PAGE;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE ? limit : null;
}

export function supportAdminRepo(scope: AdminScope): SupportAdminRepo {
  const canAct = ROLES.includes(scope.actor.role);

  return {
    async list(input) {
      if (!canAct || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { status, limit, after } = input ?? {};
      const size = pageSize(limit);
      if (
        size === null ||
        (status !== undefined && !(CASE_STATUSES as readonly string[]).includes(status)) ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      const conditions = [sql`true`];
      if (status !== undefined) conditions.push(sql`s.status = ${status}`);
      if (after !== undefined) conditions.push(sql`s.id < ${after}`);
      const result = await scope.tx.execute<RequestDbRow>(
        sql`${SELECT_REQUEST} where ${sql.join(conditions, sql` and `)} order by s.id desc limit ${size + 1}`,
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

    async detail(requestId) {
      if (!canAct || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (typeof requestId !== "string" || !isUuid(requestId)) return refused("not_found");
      const found = await scope.tx.execute<RequestDbRow & { message: string }>(
        sql`select s.id, s.customer_id, coalesce(s.name, c.name) as name, s.email,
          c.email as customer_email, s.category, s.subject, s.status, s.related_resource_id,
          s.handled_by, s.created_at, s.message
          from support_requests s left join customers c on c.id = s.customer_id where s.id = ${requestId}`,
      );
      const row = found.rows[0];
      if (row === undefined) return refused("not_found");
      const trail = await scope.tx.execute<{
        id: string;
        action: string;
        actor_id: string | null;
        reason: string | null;
        created_at: Date;
      }>(
        sql`select id, action, actor_id, metadata->>'reason' as reason, created_at from audit_log
          where target_type = 'support_request' and target_id = ${requestId}
          order by created_at desc, id desc limit ${AUDIT_LIMIT}`,
      );
      return {
        ok: true,
        replayed: false,
        value: {
          ...toRow(row),
          message: row.message,
          audit: trail.rows.map((a) => ({
            id: a.id,
            action: a.action,
            actorId: a.actor_id,
            reason: a.reason,
            createdAt: a.created_at,
          })),
        },
      };
    },

    async reply(input, reason) {
      const { requestId, replyId, body } = input;
      if (!canAct) return refused("forbidden");
      if (
        typeof requestId !== "string" ||
        !isUuid(requestId) ||
        typeof replyId !== "string" ||
        !isUuid(replyId) ||
        typeof body !== "string" ||
        body.trim() === "" ||
        body.length > MAX_BODY
      ) {
        return refused("validation");
      }
      try {
        return await audited(
          scope,
          { action: "support.reply", targetType: "support_request", targetId: requestId, reason },
          async () => {
            const { rows } = await scope.tx.execute<{
              customer_id: string | null;
              email: string | null;
              status: string;
            }>(
              sql`select customer_id, email, status from support_requests where id = ${requestId} for update`,
            );
            const current = rows[0];
            if (current === undefined) throw new Refusal("not_found");
            if (current.status !== "open") throw new Refusal("conflict");
            // A customer is reached through the customer row (the notifier reads the address there); a
            // visitor through the address of the request.
            const toEmail = current.customer_id === null ? current.email : null;
            const dedupeKey = `support-reply:${requestId}:${replyId}`;
            const inserted = await scope.tx.execute<{ id: string }>(
              sql`insert into notifications (id, customer_id, email, channel, template, payload, dedupe_key)
                values (${uuidv7()}, ${current.customer_id}, ${toEmail}, 'email', ${SUPPORT_REPLY_TEMPLATE},
                  ${JSON.stringify({ requestId, body: body.trim() })}::jsonb, ${dedupeKey})
                on conflict (dedupe_key) do nothing returning id`,
            );
            const replayed = inserted.rows.length === 0;
            if (!replayed) {
              await scope.tx.execute(
                sql`update support_requests set handled_by = ${scope.actor.adminId} where id = ${requestId}`,
              );
            }
            return {
              value: { requestId, replyId },
              replayed,
              before: null,
              after: { replyId, length: body.trim().length },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    async close(input, reason) {
      const { requestId } = input;
      if (!canAct) return refused("forbidden");
      if (typeof requestId !== "string" || !isUuid(requestId)) return refused("validation");
      try {
        return await audited(
          scope,
          { action: "support.close", targetType: "support_request", targetId: requestId, reason },
          async () => {
            const { rows } = await scope.tx.execute<{ status: string; handled_by: string | null }>(
              sql`select status, handled_by from support_requests where id = ${requestId} for update`,
            );
            const current = rows[0];
            if (current === undefined) throw new Refusal("not_found");
            const closed = current.status === "closed";
            if (!closed) {
              await scope.tx.execute(
                sql`update support_requests set status = 'closed',
                  handled_by = coalesce(handled_by, ${scope.actor.adminId}) where id = ${requestId}`,
              );
            }
            return {
              value: { requestId, status: "closed" as CaseStatus },
              replayed: closed,
              before: { status: current.status },
              after: { status: "closed" },
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
