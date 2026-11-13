import { sql } from "drizzle-orm";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";
import { CASE_STATUSES, SUPPORT_STATUSES } from "../../schema/service";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import {
  SUPPORT_THREAD_LIMIT,
  messageBody,
  threadPage,
  type SupportAuthorType,
  type SupportStatus,
} from "../support-thread";
import { audited, isActiveAdmin } from "./audited";
import { maskEmail } from "./customers";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /support: the support requests, replyByEmail and closeRequest, and since WPU-Z5 (owner decision
// 2026-11-13, round 3) the thread of each request and reopenRequest. The roles column of 16.12 says
// `support`; `superadmin` owns every area (6.2). The role check here is a second layer behind
// requireAdmin(roles) (R9, R16). Every write goes through `audited` (R10). The address of a requester never
// leaves this file unmasked (R14); the text of a reply goes to the thread (support_messages) and to the
// notification, never into the audit row.
const ROLES: readonly AdminRole[] = ["support", "superadmin"];

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
const AUDIT_LIMIT = 30;
export const SUPPORT_REPLY_TEMPLATE = "support_reply";

// The states of an abuse case (and of the case screens' shared filter); a support request has its own
// three, SupportStatus.
export type CaseStatus = (typeof CASE_STATUSES)[number];
export type { SupportAuthorType, SupportStatus };

export interface SupportListInput {
  status?: SupportStatus;
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
  status: SupportStatus;
  relatedResourceId: string | null;
  handledBy: string | null;
  createdAt: Date;
  /** The time of the last message of the thread. */
  lastActivityAt: Date;
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

/** A reply of the thread: who wrote it, the admin when it is an admin's, the text and the time. */
export interface SupportThreadMessage {
  id: string;
  authorType: SupportAuthorType;
  adminId: string | null;
  body: string;
  createdAt: Date;
}

export interface SupportRequestDetail extends SupportRequestRow {
  /** The first entry of the thread: the text of the request. */
  message: string;
  /** The replies after it, oldest first: at most SUPPORT_THREAD_LIMIT, the latest ones. */
  messages: SupportThreadMessage[];
  /** True when the thread has earlier replies than those in `messages`. */
  hasEarlier: boolean;
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
  status: SupportStatus;
}

export interface SupportReopenInput {
  requestId: string;
}

export interface SupportReopened {
  requestId: string;
  status: SupportStatus;
}

export interface SupportAdminRepo {
  list(input: SupportListInput): Promise<Written<SupportListResult>>;
  detail(requestId: string): Promise<Written<SupportRequestDetail>>;
  reply(input: SupportReplyInput, reason: string): Promise<Written<SupportReplied>>;
  close(input: SupportCloseInput, reason: string): Promise<Written<SupportClosed>>;
  reopen(input: SupportReopenInput, reason: string): Promise<Written<SupportReopened>>;
}

// The data of the `support_reply` notification (packages/notify checks it against the closed list of the
// template, test/wpu-z5-support-reply.test.ts there). A customer reads the reply in the panel and gets a link
// to the request; a visitor has no account and gets the text by e-mail.
export function supportReplyPayload(
  requestId: string,
  body: string,
  audience: "customer" | "visitor",
): { requestId: string; body: string; audience: "customer" | "visitor" } {
  return { requestId, body, audience };
}

// The id of the admin message of one reply: a UUID v5 of the reply id inside the namespace of the request,
// so the same form submitted again finds its message (R7) and one reply id cannot reach another request.
export function supportReplyMessageId(requestId: string, replyId: string): string {
  return uuidv5(replyId.toLowerCase(), requestId.toLowerCase());
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
  last_activity_at: Date;
};

const SELECT_REQUEST = sql`select s.id, s.customer_id, coalesce(s.name, c.name) as name, s.email,
  c.email as customer_email, s.category, s.subject, s.status, s.related_resource_id, s.handled_by,
  s.created_at, s.last_activity_at
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
    status: r.status as SupportStatus,
    relatedResourceId: r.related_resource_id,
    handledBy: r.handled_by,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
  };
};

function pageSize(limit: number | undefined): number | null {
  if (limit === undefined) return DEFAULT_PAGE;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE ? limit : null;
}

export function supportAdminRepo(scope: AdminScope): SupportAdminRepo {
  const canAct = ROLES.includes(scope.actor.role);

  // The state of a request under a row lock until the transaction ends: a reply, a close and a reopen
  // of the same request run one after the other. Throws a refusal when the request does not exist.
  const lockState = async (requestId: string): Promise<{ status: string }> => {
    const { rows } = await scope.tx.execute<{ status: string }>(
      sql`select status from support_requests where id = ${requestId} for update`,
    );
    const current = rows[0];
    if (current === undefined) throw new Refusal("not_found");
    return current;
  };

  // close and reopen: one audited change of the state. The same state again is a replay with its own
  // audit row (as every admin action, R10); a status change does not move the last activity (the time of
  // the last message).
  const setState = async (
    requestId: unknown,
    reason: string,
    to: "closed" | "open",
  ): Promise<Written<{ requestId: string; status: SupportStatus }>> => {
    if (!canAct) return refused("forbidden");
    if (typeof requestId !== "string" || !isUuid(requestId)) return refused("validation");
    const id = requestId.toLowerCase();
    try {
      return await audited(
        scope,
        {
          action: to === "closed" ? "support.close" : "support.reopen",
          targetType: "support_request",
          targetId: id,
          reason,
        },
        async () => {
          const current = await lockState(id);
          const already = current.status === to;
          if (!already) {
            await scope.tx.execute(
              to === "closed"
                ? sql`update support_requests set status = 'closed',
                    handled_by = coalesce(handled_by, ${scope.actor.adminId}) where id = ${id}`
                : sql`update support_requests set status = 'open' where id = ${id}`,
            );
          }
          return {
            value: { requestId: id, status: to },
            replayed: already,
            before: { status: current.status },
            after: { status: to },
          };
        },
      );
    } catch (error) {
      if (error instanceof Refusal) return refused(error.code);
      throw error;
    }
  };

  return {
    async list(input) {
      if (!canAct || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { status, limit, after } = input ?? {};
      const size = pageSize(limit);
      if (
        size === null ||
        (status !== undefined && !(SUPPORT_STATUSES as readonly string[]).includes(status)) ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      const conditions = [sql`true`];
      if (status !== undefined) conditions.push(sql`s.status = ${status}`);
      // The rows after the last row of the page before, in the order of the list (newest activity first).
      if (after !== undefined) {
        conditions.push(
          sql`(s.last_activity_at, s.id) < (select a.last_activity_at, a.id from support_requests a where a.id = ${after})`,
        );
      }
      const result = await scope.tx.execute<RequestDbRow>(
        sql`${SELECT_REQUEST} where ${sql.join(conditions, sql` and `)} order by s.last_activity_at desc, s.id desc limit ${size + 1}`,
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
          s.handled_by, s.created_at, s.last_activity_at, s.message
          from support_requests s left join customers c on c.id = s.customer_id where s.id = ${requestId}`,
      );
      const row = found.rows[0];
      if (row === undefined) return refused("not_found");
      // The replies, latest first so that the cap keeps the newest; the page turns them oldest first.
      const latest = await scope.tx.execute<{
        id: string;
        author_type: string;
        admin_id: string | null;
        body: string;
        created_at: Date;
      }>(
        sql`select id, author_type, admin_id, body, created_at from support_messages
          where request_id = ${requestId} order by created_at desc, id desc limit ${SUPPORT_THREAD_LIMIT + 1}`,
      );
      const page = threadPage(latest.rows);
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
          messages: page.messages.map((m) => ({
            id: m.id,
            authorType: m.author_type as SupportAuthorType,
            adminId: m.admin_id,
            body: m.body,
            createdAt: m.created_at,
          })),
          hasEarlier: page.hasEarlier,
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
      const { requestId: rawRequestId, replyId: rawReplyId, body: rawBody } = input ?? {};
      if (!canAct) return refused("forbidden");
      const body = messageBody(rawBody);
      if (
        typeof rawRequestId !== "string" ||
        !isUuid(rawRequestId) ||
        typeof rawReplyId !== "string" ||
        !isUuid(rawReplyId) ||
        body === null
      ) {
        return refused("validation");
      }
      const requestId = rawRequestId.toLowerCase();
      const replyId = rawReplyId.toLowerCase();
      const messageId = supportReplyMessageId(requestId, replyId);
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
            const after = { replyId, length: body.length };
            // R7: the reply id names one message. The same reply again is a replay, also after the request
            // was closed; another text under the same id is a conflict. Nothing else is written then.
            const stored = await scope.tx.execute<{
              request_id: string;
              author_type: string;
              body: string;
            }>(
              sql`select request_id, author_type, body from support_messages where id = ${messageId}`,
            );
            const earlier = stored.rows[0];
            if (earlier !== undefined) {
              if (
                earlier.request_id !== requestId ||
                earlier.author_type !== "admin" ||
                earlier.body !== body
              ) {
                throw new Refusal("conflict");
              }
              return {
                value: { requestId, replyId },
                replayed: true,
                before: { status: current.status },
                after: { status: current.status, ...after },
              };
            }
            // A closed request is answered after it was reopened (reopenRequest).
            if (current.status === "closed") throw new Refusal("conflict");
            await scope.tx.execute(
              sql`insert into support_messages (id, request_id, author_type, admin_id, body)
                values (${messageId}, ${requestId}, 'admin', ${scope.actor.adminId}, ${body})`,
            );
            // A customer is reached through the customer row (the notifier reads the address there) and
            // reads the reply in the panel; a visitor through the address of the request, with the text.
            const visitor = current.customer_id === null;
            const toEmail = visitor ? current.email : null;
            const payload = supportReplyPayload(requestId, body, visitor ? "visitor" : "customer");
            // admin_rw may insert notifications but not read them (migration 0006): no RETURNING and no
            // conflict target (both need SELECT). The key is the one of today; the message above already
            // decided that this reply is new.
            await scope.tx.execute(
              sql`insert into notifications (id, customer_id, email, channel, template, payload, dedupe_key)
                values (${uuidv7()}, ${current.customer_id}, ${toEmail}, 'email', ${SUPPORT_REPLY_TEMPLATE},
                  ${JSON.stringify(payload)}::jsonb, ${`support-reply:${requestId}:${replyId}`})
                on conflict do nothing`,
            );
            await scope.tx.execute(
              sql`update support_requests set status = 'answered', last_activity_at = now(),
                handled_by = ${scope.actor.adminId} where id = ${requestId}`,
            );
            return {
              value: { requestId, replyId },
              replayed: false,
              before: { status: current.status },
              after: { status: "answered", ...after },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    close: (input, reason) => setState(input?.requestId, reason, "closed"),

    reopen: (input, reason) => setState(input?.requestId, reason, "open"),
  };
}
