import type { AuditFilter } from "@tc/db";
import { isUuid } from "./schemas.ts";

// The filter of /audit and of its CSV export, from the URL. A value that is not one of ours is dropped
// (the page then shows the unfiltered or less filtered log), never passed on. Pure: no next/* import.
export interface AuditQuery {
  readonly actorId: string | null;
  readonly actorType: "admin" | "customer" | "system" | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly action: string | null;
  // Dhaka calendar days, YYYY-MM-DD; `to` is inclusive.
  readonly from: string | null;
  readonly to: string | null;
  readonly after: string | null;
}

const TARGET_TYPE = /^[a-z][a-z0-9_]{0,39}$/;
const ACTION = /^[A-Za-z0-9_.:-]{1,80}$/;
const TARGET_ID = /^[\x21-\x7e]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACTOR_TYPES = ["admin", "customer", "system"] as const;
const DAY_MS = 86_400_000;

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const dayStart = (day: string): Date => new Date(`${day}T00:00:00+06:00`);
// A real calendar day: 2026-02-30 is not (the date would roll over, so it fails the round trip).
const validDay = (day: string): boolean => {
  if (!DAY.test(day)) return false;
  const ms = dayStart(day).getTime();
  return !Number.isNaN(ms) && new Date(ms + 6 * 3_600_000).toISOString().slice(0, 10) === day;
};

export function auditQueryOf(raw: Record<string, string | string[] | undefined>): AuditQuery {
  const actorId = one(raw["actor"]);
  const actorType = one(raw["actorType"]);
  const targetType = one(raw["targetType"]);
  const targetId = one(raw["targetId"]);
  const action = one(raw["action"]);
  const from = one(raw["from"]);
  const to = one(raw["to"]);
  const after = one(raw["after"]);
  return {
    actorId: isUuid(actorId) ? actorId.toLowerCase() : null,
    actorType: (ACTOR_TYPES as readonly string[]).includes(actorType)
      ? (actorType as AuditQuery["actorType"])
      : null,
    targetType: TARGET_TYPE.test(targetType) ? targetType : null,
    targetId: TARGET_ID.test(targetId) ? targetId : null,
    action: ACTION.test(action) ? action : null,
    from: validDay(from) ? from : null,
    to: validDay(to) ? to : null,
    after: isUuid(after) ? after.toLowerCase() : null,
  };
}

// The filter for the repository. A range whose end is before its start is dropped as a whole.
export function auditFilterOf(query: AuditQuery): AuditFilter {
  const filter: AuditFilter = {
    ...(query.actorId === null ? {} : { actorId: query.actorId }),
    ...(query.actorType === null ? {} : { actorType: query.actorType }),
    ...(query.targetType === null ? {} : { targetType: query.targetType }),
    ...(query.targetId === null ? {} : { targetId: query.targetId }),
    ...(query.action === null ? {} : { action: query.action }),
  };
  const from = query.from === null ? null : dayStart(query.from);
  const to = query.to === null ? null : new Date(dayStart(query.to).getTime() + DAY_MS);
  if (from !== null && to !== null && from.getTime() >= to.getTime()) return filter;
  return { ...filter, ...(from === null ? {} : { from }), ...(to === null ? {} : { to }) };
}

// The URL parameters of a query, in a fixed order (for links and for the export link).
export function auditParams(query: AuditQuery, withAfter: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (query.actorId !== null) params.set("actor", query.actorId);
  if (query.actorType !== null) params.set("actorType", query.actorType);
  if (query.targetType !== null) params.set("targetType", query.targetType);
  if (query.targetId !== null) params.set("targetId", query.targetId);
  if (query.action !== null) params.set("action", query.action);
  if (query.from !== null) params.set("from", query.from);
  if (query.to !== null) params.set("to", query.to);
  if (withAfter !== null) params.set("after", withAfter);
  return params;
}
