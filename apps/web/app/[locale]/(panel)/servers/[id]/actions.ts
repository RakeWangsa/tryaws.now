"use server";

import { extrasActionDeps, guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import {
  attachDiskCore,
  createBackupCore,
  deleteBackupCore,
  destroyDiskCore,
  destroyServerCore,
  detachDiskCore,
  renewNowCore,
  setAutoBackupCore,
  setAutoRenewCore,
} from "../../../../../server/extras-actions.ts";
import type { ExtrasResult } from "../../../../../server/extras-actions.ts";

// The thin Server Actions of the server tabs (16.10). Each one checks the origin, calls its core
// (which follows R9) and turns the result into a FormState with a fixed key (U6).

function stateOf(result: ExtrasResult): FormState {
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.approval === true ? `${result.done}:approval` : result.done };
}

type Core = (deps: ReturnType<typeof extrasActionDeps>, raw: unknown) => Promise<ExtrasResult>;

const run =
  (core: Core, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(await core(extrasActionDeps(), pick(form, names)));
  };

export const createBackupAction = run(createBackupCore, ["serverId", "requestId", "name"]);
export const deleteBackupAction = run(deleteBackupCore, ["backupId", "requestId", "confirmName"]);
export const setAutoBackupAction = run(setAutoBackupCore, [
  "serverId",
  "requestId",
  "enabled",
  "hour",
]);
export const attachDiskAction = run(attachDiskCore, [
  "diskId",
  "serverId",
  "requestId",
  "diskPath",
]);
export const detachDiskAction = run(detachDiskCore, ["diskId", "requestId"]);
export const destroyDiskAction = run(destroyDiskCore, ["diskId", "requestId", "confirmName"]);
export const setAutoRenewAction = run(setAutoRenewCore, ["serverId", "autoRenew"]);
export const renewNowAction = run(renewNowCore, ["serverId"]);
export const destroyServerAction = run(destroyServerCore, ["serverId", "requestId", "confirmName"]);
