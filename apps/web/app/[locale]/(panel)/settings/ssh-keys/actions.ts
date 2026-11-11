"use server";

import { guardAction, keyActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { addSshKeyCore, removeSshKeyCore } from "../../../../../server/key-actions.ts";

export async function addSshKeyAction(_previous: FormState, form: FormData): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await addSshKeyCore(keyActionDeps(), pick(form, ["name", "publicKey"]));
  if (!result.ok)
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  return { done: result.replayed ? "replayed" : "added" };
}

// U10: the typed name and a fresh sign-in are checked in the core, before anything is removed.
export async function removeSshKeyAction(_previous: FormState, form: FormData): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await removeSshKeyCore(keyActionDeps(), pick(form, ["id", "confirmName"]));
  if (!result.ok)
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  return { done: "removed" };
}
