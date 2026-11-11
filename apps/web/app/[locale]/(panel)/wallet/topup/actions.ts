"use server";

import { redirect } from "next/navigation";
import { startDeps } from "../../../../../server/action-env.ts";
import { runStartTopUp } from "../../../../../server/topup-core.ts";
import type { TopUpFormState } from "../../../../../server/topup-core.ts";

/**
 * Starts a top-up: the order of R9 is in runStartTopUp. Success never returns: it redirects (303) to
 * the gateway, or to the status page of the payment when the same key is submitted again (R7).
 */
export async function startTopUpAction(
  previous: TopUpFormState,
  formData: FormData,
): Promise<TopUpFormState> {
  return runStartTopUp(startDeps(redirect), previous, formData);
}
