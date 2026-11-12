"use server";

import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { makeMoneyAction, type MoneyActionKind } from "./money-flow.ts";
import { ensureAdminAuth, moneyFlowDeps } from "./runtime.ts";

// A thin Server Action (R9 is inside makeMoneyAction). A "use server" file exports async functions
// only. The kind of action comes from the form and is checked by the flow. Nothing from the request
// decides the redirect except ids that have the shape of a UUID.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_KINDS = ["reverifyPayment", "recordManualRefund"];

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function moneyAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const kind = text(form.get("kind")) as MoneyActionKind;
  const answer = await makeMoneyAction(moneyFlowDeps())({
    kind,
    id: text(form.get("id")),
    reason: text(form.get("reason")),
    customerId: text(form.get("customerId")),
    direction: text(form.get("direction")),
    amount: text(form.get("amount")),
    adjustmentKind: text(form.get("adjustmentKind")),
    evidence: text(form.get("evidence")),
  });
  const result = answer.ok ? (answer.replayed ? "replayed" : "ok") : answer.code;
  const shownCustomer = text(form.get("customerId"));
  const customerId = answer.ok && answer.customerId !== null ? answer.customerId : shownCustomer;
  const shownPayment = text(form.get("id"));
  if (PAYMENT_KINDS.includes(kind) && UUID.test(shownPayment)) {
    redirect(`${localePath(locale, `/payments/${shownPayment.toLowerCase()}`)}?result=${result}`);
  }
  // WPU-M4: the credit is asked on the page of the operation; a refusal returns there.
  const shownOperation = text(form.get("id"));
  if (kind === "creditWalletForFailedChange" && !answer.ok && UUID.test(shownOperation)) {
    redirect(
      `${localePath(locale, `/operations/${shownOperation.toLowerCase()}`)}?result=${result}`,
    );
  }
  if (kind === "resolveDiscrepancy") {
    redirect(`${localePath(locale, "/payments")}?result=${result}`);
  }
  if (!UUID.test(customerId)) redirect(localePath(locale, "/payments"));
  redirect(`${localePath(locale, `/wallets/${customerId.toLowerCase()}`)}?result=${result}`);
}
