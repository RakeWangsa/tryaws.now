"use server";

import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { makeCustomerAction, type CustomerActionKind } from "./customer-flow.ts";
import { customerFlowDeps, ensureAdminAuth } from "./runtime.ts";

// A thin Server Action (R9 is inside makeCustomerAction). A "use server" file exports async functions
// only. The kind of decision comes from the form and is checked by the flow; nothing from the request
// decides the redirect except a customer id that has the shape of a UUID.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function customerDecisionAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const answer = await makeCustomerAction(customerFlowDeps())({
    kind: text(form.get("kind")) as CustomerActionKind,
    id: text(form.get("id")),
    reason: text(form.get("reason")),
    note: text(form.get("note")),
    tier: text(form.get("tier")),
  });
  const shown = text(form.get("customerId"));
  const customerId = answer.ok ? answer.customerId : shown;
  const result = answer.ok ? (answer.replayed ? "replayed" : "ok") : answer.code;
  if (!UUID.test(customerId)) redirect(localePath(locale, "/customers"));
  redirect(`${localePath(locale, `/customers/${customerId.toLowerCase()}`)}?result=${result}`);
}
