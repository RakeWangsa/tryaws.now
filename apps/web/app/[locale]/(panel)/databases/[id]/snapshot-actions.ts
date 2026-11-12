"use server";

import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { guardAction, orderActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import {
  createDbSnapshotCore,
  deleteDbSnapshotCore,
} from "../../../../../server/db-snapshot-actions.ts";
import { createDatabaseDraftCore } from "../../../../../server/databases-actions.ts";
import type { FamilyResult } from "../../../../../server/family-actions.ts";
import { familyActionDeps } from "../../../../../server/family-deps.ts";

// The thin Server Actions of the Backups tab of a database (WPU-G9). Each checks the origin first, calls
// its core (which follows R9) and turns the result into a FormState with a fixed key (U6).

function stateOf(result: FamilyResult): FormState {
  if (!result.ok) {
    // "no price" is its own text; the core marks it with the field `price` (R16).
    if (result.error === "not_allowed" && result.fields?.["price"] === "unavailable") {
      return { error: "price_unavailable" };
    }
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.approval === true ? `${result.done}:approval` : result.done };
}

export async function createDbSnapshotAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await createDbSnapshotCore(
      familyActionDeps("database"),
      pick(form, ["databaseId", "requestId", "name"]),
    ),
  );
}

export async function deleteDbSnapshotAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await deleteDbSnapshotCore(
      familyActionDeps("database"),
      pick(form, ["backupId", "requestId", "confirmName"]),
    ),
  );
}

async function toReview(token: string): Promise<never> {
  const found = await getLocale();
  const locale: Locale = found === "en" ? "en" : "bn";
  // redirect() throws on purpose; nothing may catch it. The token is signed, so the URL holds no secret.
  redirect(`${localePath(locale, "/orders/review")}?d=${encodeURIComponent(token)}`);
}

/** A new database from a snapshot: the signed draft, then the review page where the price is shown. */
export async function restoreDatabaseSnapshotAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await createDatabaseDraftCore(
    await orderActionDeps(),
    pick(form, ["productId", "region", "displayName", "restoreFromBackupId"]),
    "snapshot",
  );
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return toReview(result.token);
}

/** A new database from a point in time of this database. */
export async function restoreDatabasePointInTimeAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await createDatabaseDraftCore(
    await orderActionDeps(),
    pick(form, ["productId", "region", "displayName", "restoreSourceId", "restoreTime"]),
    "point_in_time",
  );
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return toReview(result.token);
}
