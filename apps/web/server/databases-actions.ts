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

/** /databases/new: the form's three fields, nothing else, become the config of a database (R9, R11). */
export async function createDatabaseDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const parsed = parseDatabaseConfig({
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
  });
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
