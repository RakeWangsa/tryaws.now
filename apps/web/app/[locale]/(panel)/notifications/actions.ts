"use server";

import { extrasActionDeps, guardAction } from "../../../../server/action-deps.ts";
import { pick } from "../../../../server/action-state.ts";
import type { FormState } from "../../../../server/action-state.ts";
import { markNotificationsReadCore } from "../../../../server/extras-actions.ts";

/** `markNotificationsRead` (16.10): no id marks all of the customer's notifications. */
export async function markNotificationsReadAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  const result = await markNotificationsReadCore(extrasActionDeps(), pick(form, ["id"]));
  if (!result.ok) return { error: result.error };
  return { done: result.done };
}
