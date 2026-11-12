"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { DB_OPTIONS, consoleCore } from "../../../../../server/console-actions.ts";
import {
  destroyDatabaseCore,
  setDatabaseRunningCore,
} from "../../../../../server/databases-actions.ts";
import type { FamilyResult } from "../../../../../server/family-actions.ts";
import { familyActionDeps } from "../../../../../server/family-deps.ts";

// The thin Server Actions of the database page (16.10). Each one checks the origin, calls its core
// (which follows R9) and turns the result into a FormState with a fixed key (U6).

function stateOf(result: FamilyResult): FormState {
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.approval === true ? `${result.done}:approval` : result.done };
}

type Core = (deps: ReturnType<typeof familyActionDeps>, raw: unknown) => Promise<FamilyResult>;

const run =
  (core: Core, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(await core(familyActionDeps("database"), pick(form, names)));
  };

export const setDatabaseRunningAction = run(setDatabaseRunningCore, [
  "databaseId",
  "requestId",
  "run",
]);
export const destroyDatabaseAction = run(destroyDatabaseCore, [
  "databaseId",
  "requestId",
  "confirmName",
]);

// WPU-G7: backup window and public mode. Public mode needs the acknowledged warning (the core checks it).
export const setDatabaseOptionsAction = run(consoleCore(DB_OPTIONS), [
  "databaseId",
  "requestId",
  "backupWindow",
  "maintenanceWindow",
  "publicMode",
  "acknowledge",
]);
