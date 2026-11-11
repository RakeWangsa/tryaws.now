import { sql } from "drizzle-orm";
import type { AdminMessage } from "../../operations/admin";
import { insertOperation } from "../../operations/insert";
import { CASE_STATUSES } from "../../schema/service";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /abuse: the cases, openAbuseCase, closeAbuseCase and suspendResource (13: "Cases, suspend
// resource ..., notes"). The screen is for ops and support; `superadmin` owns every area (6.2). The
// suspension of a resource is the stronger step and is for ops and superadmin only (R16: the spec gives
// the screen two roles and no split, so the narrower reading is taken; JOURNEY has the question).
// Every write goes through `audited` (R10). The admin app never calls AWS (R1): suspendResource only
// writes an operation row of kind `suspend`; the provisioner does the work. A suspension is not a
// destructive kind (kinds.ts), so R13 asks for no approval; nothing destructive is written here.
const READ_ACT_ROLES: readonly AdminRole[] = ["ops", "support", "superadmin"];
const SUSPEND_ROLES: readonly AdminRole[] = ["ops", "superadmin"];

export const ABUSE_SOURCES = [
  "third_party_report",
  "provider_notice",
  "monitoring",
  "internal",
] as const;
export type AbuseSource = (typeof ABUSE_SOURCES)[number];
export type AbuseStatus = (typeof CASE_STATUSES)[number];

const MAX_NOTES = 2000;
const MAX_NOTE_LINE = 1000;
const MAX_NOTES_TOTAL = 20000;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
const AUDIT_LIMIT = 30;
// The payload of the suspend operation: the engine reads `adminSuspended` so that a renewal never lifts
// the suspension of an admin (11).
const SUSPEND_KEY = "abuse-suspend:";

export interface AbuseListInput {
  status?: AbuseStatus;
  limit?: number;
  after?: string;
}

export interface AbuseCaseRow {
  id: string;
  resourceId: string;
  customerId: string;
  customerName: string | null;
  family: string;
  region: string | null;
  resourceState: string;
  source: string;
  status: AbuseStatus;
  notes: string | null;
  createdAt: Date;
}

export interface AbuseListResult {
  rows: AbuseCaseRow[];
  nextAfter: string | null;
}

export interface AbuseTrailRow {
  id: string;
  action: string;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface AbuseCaseDetail extends AbuseCaseRow {
  audit: AbuseTrailRow[];
}

export interface AbuseOpenInput {
  // The idempotency key of the case (R7): the form carries it, a second submit is a replay.
  caseId: string;
  resourceId: string;
  source: AbuseSource;
  notes?: string;
}

export interface AbuseOpened {
  caseId: string;
  resourceId: string;
}

export interface AbuseNoteInput {
  caseId: string;
  // The idempotency key of the note.
  noteId: string;
  note: string;
  at: Date;
}

export interface AbuseNoted {
  caseId: string;
  noteId: string;
}

export interface AbuseCloseInput {
  caseId: string;
  at: Date;
}

export interface AbuseClosed {
  caseId: string;
  status: AbuseStatus;
}

export interface AbuseSuspendInput {
  caseId: string;
  at: Date;
}

export interface AbuseSuspended {
  caseId: string;
  resourceId: string;
  operationId: string;
  // null on a replay: the first call already has the message to send.
  message: AdminMessage | null;
}

export interface AbuseAdminRepo {
  list(input: AbuseListInput): Promise<Written<AbuseListResult>>;
  detail(caseId: string): Promise<Written<AbuseCaseDetail>>;
  open(input: AbuseOpenInput, reason: string): Promise<Written<AbuseOpened>>;
  addNote(input: AbuseNoteInput, reason: string): Promise<Written<AbuseNoted>>;
  close(input: AbuseCloseInput, reason: string): Promise<Written<AbuseClosed>>;
  suspendResource(input: AbuseSuspendInput, reason: string): Promise<Written<AbuseSuspended>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: RepoErrorCode) {
    super("abuse action refused");
  }
}

type CaseDbRow = {
  id: string;
  resource_id: string;
  customer_id: string;
  customer_name: string | null;
  family: string;
  region: string | null;
  resource_state: string;
  source: string;
  status: string;
  notes: string | null;
  created_at: Date;
};

const SELECT_CASE = sql`select a.id, a.resource_id, r.customer_id, c.name as customer_name, r.family,
  r.region, r.state as resource_state, a.source, a.status, a.notes, a.created_at
  from abuse_cases a join resources r on r.id = a.resource_id
  join customers c on c.id = r.customer_id`;

const toRow = (r: CaseDbRow): AbuseCaseRow => ({
  id: r.id,
  resourceId: r.resource_id,
  customerId: r.customer_id,
  customerName: r.customer_name,
  family: r.family,
  region: r.region,
  resourceState: r.resource_state,
  source: r.source,
  status: r.status as AbuseStatus,
  notes: r.notes,
  createdAt: r.created_at,
});

const isValidDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

function pageSize(limit: number | undefined): number | null {
  if (limit === undefined) return DEFAULT_PAGE;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE ? limit : null;
}

export function abuseAdminRepo(scope: AdminScope): AbuseAdminRepo {
  const role = scope.actor.role;
  const canAct = READ_ACT_ROLES.includes(role);
  const canSuspend = SUSPEND_ROLES.includes(role);

  // The state of a case, read under a row lock so that two admins act one after the other.
  const lockCase = async (caseId: string) => {
    const { rows } = await scope.tx.execute<{
      resource_id: string;
      status: string;
      notes: string | null;
    }>(sql`select resource_id, status, notes from abuse_cases where id = ${caseId} for update`);
    const found = rows[0];
    if (found === undefined) throw new Refusal("not_found");
    return found;
  };

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
      if (status !== undefined) conditions.push(sql`a.status = ${status}`);
      if (after !== undefined) conditions.push(sql`a.id < ${after}`);
      const result = await scope.tx.execute<CaseDbRow>(
        sql`${SELECT_CASE} where ${sql.join(conditions, sql` and `)} order by a.id desc limit ${size + 1}`,
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

    async detail(caseId) {
      if (!canAct || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (typeof caseId !== "string" || !isUuid(caseId)) return refused("not_found");
      const found = await scope.tx.execute<CaseDbRow>(sql`${SELECT_CASE} where a.id = ${caseId}`);
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
          where target_type = 'abuse_case' and target_id = ${caseId}
          order by created_at desc, id desc limit ${AUDIT_LIMIT}`,
      );
      return {
        ok: true,
        replayed: false,
        value: {
          ...toRow(row),
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

    async open(input, reason) {
      const { caseId, resourceId, source, notes } = input;
      if (!canAct) return refused("forbidden");
      if (
        typeof caseId !== "string" ||
        !isUuid(caseId) ||
        typeof resourceId !== "string" ||
        !isUuid(resourceId) ||
        !(ABUSE_SOURCES as readonly string[]).includes(source) ||
        (notes !== undefined && (typeof notes !== "string" || notes.length > MAX_NOTES))
      ) {
        return refused("validation");
      }
      const text = notes === undefined || notes.trim() === "" ? null : notes.trim();
      try {
        return await audited(
          scope,
          { action: "abuse.open", targetType: "abuse_case", targetId: caseId, reason },
          async () => {
            const resource = await scope.tx.execute<{ id: string }>(
              sql`select id from resources where id = ${resourceId}`,
            );
            if (resource.rows[0] === undefined) throw new Refusal("not_found");
            const inserted = await scope.tx.execute<{ id: string }>(
              sql`insert into abuse_cases (id, resource_id, source, notes)
                values (${caseId}, ${resourceId}, ${source}, ${text})
                on conflict (id) do nothing returning id`,
            );
            const replayed = inserted.rows.length === 0;
            if (replayed) {
              // The id is taken: the same request is a replay, another resource or source is a conflict.
              const same = await scope.tx.execute<{ resource_id: string; source: string }>(
                sql`select resource_id, source from abuse_cases where id = ${caseId}`,
              );
              const prior = same.rows[0];
              if (prior?.resource_id !== resourceId || prior.source !== source) {
                throw new Refusal("conflict");
              }
            }
            return {
              value: { caseId, resourceId },
              replayed,
              before: null,
              after: { resourceId, source },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    async addNote(input, reason) {
      const { caseId, noteId, note, at } = input;
      if (!canAct) return refused("forbidden");
      if (
        typeof caseId !== "string" ||
        !isUuid(caseId) ||
        typeof noteId !== "string" ||
        !isUuid(noteId) ||
        typeof note !== "string" ||
        note.trim() === "" ||
        note.length > MAX_NOTE_LINE ||
        !isValidDate(at)
      ) {
        return refused("validation");
      }
      try {
        return await audited(
          scope,
          { action: "abuse.note", targetType: "abuse_case", targetId: caseId, reason },
          async () => {
            const current = await lockCase(caseId);
            const value = { caseId, noteId };
            const marker = `[${noteId}]`;
            if ((current.notes ?? "").includes(marker)) {
              return { value, replayed: true, before: null, after: { noteId } };
            }
            if (current.status !== "open") throw new Refusal("conflict");
            // One line for each note: the marker is the id (the replay check), then the day, the
            // first characters of the admin id and the text.
            const line = `${marker} ${at.toISOString().slice(0, 10)} ${scope.actor.adminId.slice(0, 8)}: ${note
              .trim()
              .replace(/\s*[\r\n]+\s*/g, " ")}`;
            const next = current.notes === null ? line : `${current.notes}\n${line}`;
            if (next.length > MAX_NOTES_TOTAL) throw new Refusal("conflict");
            await scope.tx.execute(
              sql`update abuse_cases set notes = ${next} where id = ${caseId}`,
            );
            return { value, replayed: false, before: null, after: { noteId, length: note.length } };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    async close(input, reason) {
      const { caseId, at } = input;
      if (!canAct) return refused("forbidden");
      if (typeof caseId !== "string" || !isUuid(caseId) || !isValidDate(at)) {
        return refused("validation");
      }
      try {
        return await audited(
          scope,
          { action: "abuse.close", targetType: "abuse_case", targetId: caseId, reason },
          async () => {
            const current = await lockCase(caseId);
            const closed = current.status === "closed";
            if (!closed) {
              await scope.tx.execute(
                sql`update abuse_cases set status = 'closed' where id = ${caseId}`,
              );
            }
            return {
              value: { caseId, status: "closed" as AbuseStatus },
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

    async suspendResource(input, reason) {
      const { caseId, at } = input;
      if (!canSuspend) return refused("forbidden");
      if (typeof caseId !== "string" || !isUuid(caseId) || !isValidDate(at)) {
        return refused("validation");
      }
      const key = `${SUSPEND_KEY}${caseId}`;
      try {
        return await audited(
          scope,
          { action: "abuse.suspend_resource", targetType: "abuse_case", targetId: caseId, reason },
          async () => {
            const current = await lockCase(caseId);
            const resourceId = current.resource_id;
            // The key of the case: a second call finds the first operation (R7).
            const known = await scope.tx.execute<{ id: string }>(
              sql`select id from operations where idempotency_key = ${key}`,
            );
            const prior = known.rows[0];
            if (prior !== undefined) {
              return {
                value: { caseId, resourceId, operationId: prior.id, message: null },
                replayed: true,
                before: null,
                after: { resourceId, operationId: prior.id },
              };
            }
            if (current.status !== "open") throw new Refusal("conflict");
            const resource = await scope.tx.execute<{ state: string }>(
              sql`select state from resources where id = ${resourceId}`,
            );
            const state = resource.rows[0]?.state;
            if (state === undefined) throw new Refusal("not_found");
            // The same states ensureSuspended of the lifecycle engine suspends.
            if (state !== "active" && state !== "stopped") throw new Refusal("conflict");
            const op = await insertOperation(
              scope.tx,
              {
                resourceId,
                kind: "suspend",
                payload: { adminSuspended: true, abuseCaseId: caseId },
                idempotencyKey: key,
              },
              at,
            );
            return {
              value: {
                caseId,
                resourceId,
                operationId: op.operationId,
                message: op.created
                  ? { operationId: op.operationId, resourceId, enqueueSeq: op.enqueueSeq }
                  : null,
              },
              replayed: !op.created,
              before: { resourceState: state },
              after: { resourceId, operationId: op.operationId, kind: "suspend" },
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
