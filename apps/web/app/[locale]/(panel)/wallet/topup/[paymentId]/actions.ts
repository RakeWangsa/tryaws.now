"use server";

import { localePath } from "@tc/ui/runtime";
import { redirect } from "next/navigation";
import { actionEnv, recheckDeps } from "../../../../../../server/action-env.ts";
import { runRecheck } from "../../../../../../server/topup-core.ts";
import type { RecheckState } from "../../../../../../server/topup-core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Asks EPS once, through the payment service, whether this customer's open payment is settled now. */
export async function recheckPaymentAction(paymentId: string): Promise<RecheckState> {
  return runRecheck(recheckDeps, paymentId);
}

/**
 * The "Check again" button without JavaScript: the same check, then back to the status page, which
 * is read again from the row. Bound to the payment id in the page (`checkAgainAction.bind(null, id)`).
 */
export async function checkAgainAction(paymentId: string): Promise<void> {
  await runRecheck(recheckDeps, paymentId);
  const env = await actionEnv();
  redirect(
    localePath(env.locale, UUID.test(paymentId) ? `/wallet/topup/${paymentId}` : "/wallet/topup"),
  );
}
