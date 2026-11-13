"use server";

import { revalidatePath } from "next/cache";
import { guardAction, supportThreadActionDeps } from "../../../../../../server/action-deps.ts";
import {
  addSupportMessageCore,
  closeSupportRequestCore,
  type SupportThreadResult,
} from "../../../../../../server/support-thread-actions.ts";

// The Server Actions of /support/requests/[id] (WPU-Z6). Each takes one plain object from the form; the
// customer id is never part of it (R8). The origin check runs first, then the core runs R9 (authenticate,
// authorize, validate, rate limit, execute, audit).

export type ThreadActionResult = SupportThreadResult | { ok: false; error: "forbidden" };

function refresh(): void {
  // The thread and the list show the change straight away.
  revalidatePath("/[locale]/support/requests/[id]", "page");
  revalidatePath("/[locale]/support/requests", "page");
}

export async function addSupportMessageAction(input: unknown): Promise<ThreadActionResult> {
  if (!(await guardAction())) return { ok: false, error: "forbidden" };
  const result = await addSupportMessageCore(supportThreadActionDeps(), input);
  if (result.ok) refresh();
  return result;
}

export async function closeSupportRequestAction(input: unknown): Promise<ThreadActionResult> {
  if (!(await guardAction())) return { ok: false, error: "forbidden" };
  const result = await closeSupportRequestCore(supportThreadActionDeps(), input);
  if (result.ok) refresh();
  return result;
}
