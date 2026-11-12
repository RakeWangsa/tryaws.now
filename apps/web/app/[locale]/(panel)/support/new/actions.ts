"use server";

import { revalidatePath } from "next/cache";
import { guardAction, supportActionDeps } from "../../../../../server/action-deps.ts";
import {
  createSupportRequestCore,
  type SupportResult,
} from "../../../../../server/support-actions.ts";

// The Server Action of /support/new (16.10 createSupportRequest). It takes one plain object from the
// form; the customer id is never part of it (R8). The origin check runs first, then the core runs
// R9 (authenticate, authorize, validate, rate limit, execute, audit).

export type SupportActionResult = SupportResult | { ok: false; error: "forbidden" };

export async function createSupportRequestAction(input: unknown): Promise<SupportActionResult> {
  if (!(await guardAction())) return { ok: false, error: "forbidden" };
  const result = await createSupportRequestCore(supportActionDeps(), input);
  // The list of earlier requests shows the new one straight away.
  if (result.ok) revalidatePath("/[locale]/support/new", "page");
  return result;
}
