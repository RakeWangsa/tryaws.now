import { and, desc, eq, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { resources, supportRequests } from "../../schema/index";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";
import {
  SUPPORT_THREAD_LIMIT,
  messageBody,
  threadPage,
  type SupportAuthorType,
  type SupportStatus,
} from "../support-thread";

// The customer's own support requests (16.10 /support when signed in, WP9-T4b) and, since WPU-Z5, their
// thread. web_rw may INSERT id, customer_id, name, email, category, related_resource_id, subject, message
// and SELECT id, customer_id, category, related_resource_id, subject, message, status, created_at (0006),
// and since 0027 SELECT last_activity_at, UPDATE (status, last_activity_at), and on support_messages SELECT
// (id, request_id, author_type, body, created_at) and INSERT (id, request_id, author_type, body): it never
// reads or names the admin of a message, and never sets the handler. Every statement binds the customer of
// the scope (R8); a request of another customer answers like a missing one (not_found).
export interface NewSupportRequest {
  category: string;
  subject: string;
  message: string;
  /** A resource of this customer, or null. A resource of another customer is not_found (R8). */
  relatedResourceId: string | null;
  /** The idempotency key (R7): the row id is derived from the customer and this key. */
  idempotencyKey: string;
}

export interface CustomerSupportRequestRow {
  id: string;
  category: string;
  subject: string;
  status: SupportStatus;
  createdAt: Date;
  /** The time of the last message of the thread (the request itself, or the latest reply). */
  lastActivityAt: Date;
}

/** A reply of the thread as the customer sees it: who wrote it (never which admin), the text and the time. */
export interface CustomerSupportMessage {
  id: string;
  authorType: SupportAuthorType;
  body: string;
  createdAt: Date;
}

export interface CustomerSupportThread {
  id: string;
  category: string;
  subject: string;
  status: SupportStatus;
  createdAt: Date;
  lastActivityAt: Date;
  /** The first entry of the thread: the text the customer sent with the request. */
  message: string;
  /** The replies after it, oldest first: at most SUPPORT_THREAD_LIMIT, the latest ones. */
  messages: CustomerSupportMessage[];
  /** True when the thread has earlier replies than those in `messages`. */
  hasEarlier: boolean;
}

export interface NewSupportMessage {
  requestId: string;
  /** The idempotency key (R7): the message id is derived from the customer and this key. */
  idempotencyKey: string;
  /** 1 to 5000 characters after CRLF becomes LF and the text is trimmed. */
  body: string;
}

export interface SupportRepo {
  /** Newest activity first, at most `limit` (default 20, at most 100). Only columns web_rw may read. */
  list(limit?: number): Promise<CustomerSupportRequestRow[]>;
  create(input: NewSupportRequest): Promise<Written<{ id: string }>>;
  /** The request and its replies. Another customer's request, a missing one and a bad id: not_found. */
  thread(requestId: string): Promise<Written<CustomerSupportThread>>;
  /**
   * A reply of the customer. It opens the request again (`answered` or `closed` become `open`) and moves its
   * last activity. The same key and text again is a replay; the same key with another text is a conflict.
   */
  addMessage(input: NewSupportMessage): Promise<Written<{ id: string }>>;
  /** Closes the request; a closed request is a replay. */
  close(requestId: string): Promise<Written<{ id: string }>>;
}

const LIST_COLUMNS = {
  id: supportRequests.id,
  category: supportRequests.category,
  subject: supportRequests.subject,
  status: supportRequests.status,
  createdAt: supportRequests.createdAt,
  lastActivityAt: supportRequests.lastActivityAt,
};

// The key of a message (R7): the characters a form token or a UUID uses, as for operations.
const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

// The id of a request: a UUID v5 of the idempotency key inside the namespace of the customer (a
// customer id is a UUID). The same customer and key give the same id on every call, so the primary
// key is the unique key of R7; another customer with the same key gets another id.
export function supportRequestId(customerId: string, idempotencyKey: string): string {
  return uuidv5(idempotencyKey, customerId);
}

// The id of a message of the thread: the same rule as the id of a request (WPU-Z5).
export function supportMessageId(customerId: string, idempotencyKey: string): string {
  return uuidv5(idempotencyKey, customerId);
}

type ThreadRequestRow = {
  id: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  created_at: Date | string;
  last_activity_at: Date | string;
};
type ThreadMessageRow = { id: string; author_type: string; body: string; created_at: Date | string };

// A raw tx.execute answers timestamptz as text (no type parser for it on main); the thread hands out Date
// objects like list() does, so the page can format the times in the customer's locale (WPU-Z6).
const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export function supportRepo(scope: TenantScope): SupportRepo {
  const { tx, customerId } = scope;

  // The status of the customer's own request, under a row lock until the transaction ends, so that a
  // reply and a close of the same request run one after the other. Undefined: missing or not this
  // customer's (R8).
  const lockOwn = async (requestId: string): Promise<string | undefined> => {
    const { rows } = await tx.execute<{ status: string }>(
      sql`select status from support_requests where id = ${requestId} and customer_id = ${customerId} for update`,
    );
    return rows[0]?.status;
  };

  return {
    list: async (limit = 20) =>
      (await tx
        .select(LIST_COLUMNS)
        .from(supportRequests)
        .where(eq(supportRequests.customerId, customerId))
        .orderBy(
          desc(supportRequests.lastActivityAt),
          desc(supportRequests.createdAt),
          desc(supportRequests.id),
        )
        .limit(Math.min(Math.max(Math.trunc(limit), 1), 100))) as CustomerSupportRequestRow[],

    create: async (input) => {
      const id = supportRequestId(customerId, input.idempotencyKey);
      const related = input.relatedResourceId;
      if (related !== null) {
        // A resource of another customer, a missing one and one that is not a UUID answer alike (R8).
        if (!isUuid(related)) return refused("not_found");
        const [own] = await tx
          .select({ id: resources.id })
          .from(resources)
          .where(and(eq(resources.id, related), eq(resources.customerId, customerId)));
        if (own === undefined) return refused("not_found");
      }
      // The sql template names only the columns web_rw may insert (created_at, status and
      // last_activity_at take their defaults). ON CONFLICT DO NOTHING, never a caught 23505, so the
      // caller's transaction lives.
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into support_requests
          (id, customer_id, category, related_resource_id, subject, message)
        values
          (${id}, ${customerId}, ${input.category}, ${related}, ${input.subject},
           ${input.message})
        on conflict (id) do nothing
        returning id
      `);
      if (rows[0] !== undefined) return created({ id });

      const [existing] = await tx
        .select({
          category: supportRequests.category,
          subject: supportRequests.subject,
          message: supportRequests.message,
          relatedResourceId: supportRequests.relatedResourceId,
        })
        .from(supportRequests)
        .where(and(eq(supportRequests.id, id), eq(supportRequests.customerId, customerId)));
      // No row: the conflict was something else. Fail closed (R16).
      if (existing === undefined) return refused("conflict");
      return existing.category === input.category &&
        existing.subject === input.subject &&
        existing.message === input.message &&
        existing.relatedResourceId === related
        ? replayed({ id })
        : refused("conflict");
    },

    thread: async (requestId) => {
      if (typeof requestId !== "string" || !isUuid(requestId)) return refused("not_found");
      const found = await tx.execute<ThreadRequestRow>(
        sql`select id, category, subject, message, status, created_at, last_activity_at
          from support_requests where id = ${requestId} and customer_id = ${customerId}`,
      );
      const request = found.rows[0];
      if (request === undefined) return refused("not_found");
      // The replies, latest first so that the cap keeps the newest; the page turns them oldest first.
      // The join binds the customer again: no message of another customer's request can come back.
      const latest = await tx.execute<ThreadMessageRow>(
        sql`select m.id, m.author_type, m.body, m.created_at
          from support_messages m join support_requests r on r.id = m.request_id
          where m.request_id = ${requestId} and r.customer_id = ${customerId}
          order by m.created_at desc, m.id desc limit ${SUPPORT_THREAD_LIMIT + 1}`,
      );
      const page = threadPage(latest.rows);
      return {
        ok: true,
        replayed: false,
        value: {
          id: request.id,
          category: request.category,
          subject: request.subject,
          status: request.status as SupportStatus,
          createdAt: asDate(request.created_at),
          lastActivityAt: asDate(request.last_activity_at),
          message: request.message,
          messages: page.messages.map((m) => ({
            id: m.id,
            authorType: m.author_type as SupportAuthorType,
            body: m.body,
            createdAt: asDate(m.created_at),
          })),
          hasEarlier: page.hasEarlier,
        },
      };
    },

    addMessage: async (input) => {
      const { requestId: rawRequestId, idempotencyKey } = input ?? {};
      const body = messageBody(input?.body);
      if (
        body === null ||
        typeof idempotencyKey !== "string" ||
        !KEY_PATTERN.test(idempotencyKey)
      ) {
        return refused("validation");
      }
      if (typeof rawRequestId !== "string" || !isUuid(rawRequestId)) return refused("not_found");
      // The database answers a uuid in lower case: the replay below compares with this spelling.
      const requestId = rawRequestId.toLowerCase();
      if ((await lockOwn(requestId)) === undefined) return refused("not_found");
      const id = supportMessageId(customerId, idempotencyKey);
      // The insert selects the request by the customer once more (R8), names only the columns web_rw may
      // insert (created_at takes its default), and does nothing on a key that is taken (no caught 23505).
      const inserted = await tx.execute<{ id: string }>(
        sql`insert into support_messages (id, request_id, author_type, body)
          select ${id}, r.id, 'customer', ${body} from support_requests r
          where r.id = ${requestId} and r.customer_id = ${customerId}
          on conflict (id) do nothing returning id`,
      );
      if (inserted.rows[0] !== undefined) {
        // A reply of the customer waits for support again, whatever the state was.
        await tx.execute(
          sql`update support_requests set status = 'open', last_activity_at = now()
            where id = ${requestId} and customer_id = ${customerId}`,
        );
        return created({ id });
      }
      const existing = await tx.execute<{ request_id: string; author_type: string; body: string }>(
        sql`select m.request_id, m.author_type, m.body
          from support_messages m join support_requests r on r.id = m.request_id
          where m.id = ${id} and r.customer_id = ${customerId}`,
      );
      const row = existing.rows[0];
      // No row of this customer under the key: the conflict was something else. Fail closed (R16).
      return row !== undefined &&
        row.request_id === requestId &&
        row.author_type === "customer" &&
        row.body === body
        ? replayed({ id })
        : refused("conflict");
    },

    close: async (rawRequestId) => {
      if (typeof rawRequestId !== "string" || !isUuid(rawRequestId)) return refused("not_found");
      const requestId = rawRequestId.toLowerCase();
      const status = await lockOwn(requestId);
      if (status === undefined) return refused("not_found");
      // Closing does not move the last activity: it is the time of the last message.
      if (status === "closed") return replayed({ id: requestId });
      await tx.execute(
        sql`update support_requests set status = 'closed'
          where id = ${requestId} and customer_id = ${customerId}`,
      );
      return created({ id: requestId });
    },
  };
}
