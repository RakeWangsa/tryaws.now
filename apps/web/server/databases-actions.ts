import { parseDatabaseConfig } from "@tc/core";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";
import { destroyFamilyCore, setRunningCore } from "./family-actions.ts";
import type { FamilyActionDeps, FamilyResult, FamilySpec } from "./family-actions.ts";

// The cores of the Server Actions of the database screens (/databases, 16.10): `createOrderDraft`
// (review), stop and start, and `destroyDatabase`. R9 order in each (see family-actions.ts). Every
// action is an operation row or a draft (R1: nothing here calls AWS). What leaves a core is a fixed
// public key, never the text of an error (U6).
//
// Not built here, because the web tier has no way to do it without AWS or the backend has no kind for
// it yet: the manual backup (`createBackup`, the repository accepts only server and disk parents),
// `setPublicMode` (no operation kind; a database is created private) and the metrics read. The page
// says so (JOURNEY.md, Needs decision).

export const DATABASE_SPEC: FamilySpec = {
  family: "database",
  idField: "databaseId",
  prefix: "database",
  withFinalSnapshot: true,
};

function text(input: Record<string, unknown>, key: string): unknown {
  const value = input[key];
  return typeof value === "string" ? value.trim() : value;
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * WPU-G9. A `datetime-local` value is read as a time in Dhaka (UTC+6, no daylight saving) and becomes
 * an ISO instant. null for anything else, including a date that does not exist.
 */
export function dhakaLocalToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = LOCAL_TIME.exec(value.trim());
  if (m === null) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(Date.UTC(y, mo - 1, d, h - 6, mi));
  // A rolled-over date (month 13, day 40) is not a date.
  const back = new Date(at.getTime() + 6 * 3600 * 1000);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi
  ) {
    return null;
  }
  return at.toISOString();
}

/**
 * /databases/new: the form's three fields, nothing else, become the config of a database (R9, R11).
 * `mode` is an argument of the code (WPU-G9), never a form field: "snapshot" adds the id of a snapshot,
 * "point_in_time" adds the source database and the instant. The order code checks both against the
 * customer's own rows (R8) and the retention window.
 */
export async function createDatabaseDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
  mode: "new" | "snapshot" | "point_in_time" = "new",
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const restore: Record<string, unknown> = {};
  if (mode === "snapshot") restore["restoreFromBackupId"] = text(input, "restoreFromBackupId");
  if (mode === "point_in_time") {
    restore["restoreSourceId"] = text(input, "restoreSourceId");
    restore["restoreTime"] = dhakaLocalToIso(input["restoreTime"]) ?? "invalid";
  }
  const parsed = parseDatabaseConfig({
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
    ...restore,
  });
  if (mode === "snapshot" && restore["restoreFromBackupId"] === undefined) {
    return { ok: false, error: "validation", fields: { restoreFromBackupId: "invalid" } };
  }
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  const result = await deps.orders.createOrderDraft(session, {
    family: "database",
    config: { ...parsed.value },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error),
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

/** Stop from active, start from stopped. */
export const setDatabaseRunningCore = (
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> => setRunningCore(deps, DATABASE_SPEC, raw);

/** 16.10 `destroyDatabase` (U10, R13): a final snapshot, and approval until 2026-12-01. */
export const destroyDatabaseCore = (deps: FamilyActionDeps, raw: unknown): Promise<FamilyResult> =>
  destroyFamilyCore(deps, DATABASE_SPEC, raw);
