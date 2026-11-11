"use server";

import { notFound, redirect } from "next/navigation";
import { devEps, devSurfaceEnabled, isDevData } from "../../../../../server/dev-surface.ts";

// Development and test only: the buttons of the fake EPS page. Settling the fake makes the next
// server-to-server verify (R6) answer Success, Failed or Cancelled; the browser then returns through
// the same route a real EPS would use, with the merchant transaction id in the query.

const OUTCOMES = {
  pay: { status: "Success", route: "success" },
  fail: { status: "Failed", route: "fail" },
  cancel: { status: "Cancelled", route: "cancel" },
} as const;

export async function settleFakeEps(formData: FormData): Promise<void> {
  if (!devSurfaceEnabled()) notFound();
  const data = formData.get("data");
  const outcome = formData.get("outcome");
  if (!isDevData(data) || typeof outcome !== "string" || !Object.hasOwn(OUTCOMES, outcome)) {
    notFound();
  }
  const dev = devEps();
  const merchantTransactionId = dev?.byData.get(data);
  if (dev === null || merchantTransactionId === undefined) notFound();
  const chosen = OUTCOMES[outcome as keyof typeof OUTCOMES];
  dev.fake.settle(merchantTransactionId, { status: chosen.status });
  redirect(
    `/pay/eps/${chosen.route}?MerchantTransactionId=${encodeURIComponent(merchantTransactionId)}`,
  );
}
