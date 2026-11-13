"use server";

import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { makeOpsAction } from "./ops-flow.ts";
import { makePlanMarkAction } from "./plan-mark-flow.ts";
import { makeConfirmUnrenewedAction } from "./renewal-flow.ts";
import type { OpsActionKind } from "./ops-map.ts";
import { isUuid } from "./schemas.ts";
import { makeUnpaidRuleAction } from "./unpaid-rule-flow.ts";
import { ensureAdminAuth, opsFlowDeps, unpaidRuleFlowDeps } from "./runtime.ts";

// A thin Server Action (R9 is inside makeOpsAction). The form carries the kind, the operation and the
// reason; it carries no approver: the approver is the admin of the session.

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function operationAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const id = text(form.get("id"));
  const answer = await makeOpsAction(opsFlowDeps())({
    kind: text(form.get("kind")) as OpsActionKind,
    id,
    reason: text(form.get("reason")),
  });
  const result = answer.ok ? (answer.replayed ? "replayed" : "ok") : answer.code;
  if (!isUuid(id)) redirect(localePath(locale, "/operations"));
  redirect(`${localePath(locale, `/operations/${id.toLowerCase()}`)}?result=${result}`);
}

// WPA-P2. The form carries the resource, the id of the form (a repeat of the same form is a replay) and
// the reason; it carries no actor and no role.
export async function clearPlanChangeMarkAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const id = text(form.get("resourceId"));
  const answer = await makePlanMarkAction(opsFlowDeps())({
    resourceId: id,
    requestId: text(form.get("requestId")),
    reason: text(form.get("reason")),
  });
  const result = answer.ok ? (answer.replayed ? "replayed" : "ok") : answer.code;
  if (!isUuid(id)) redirect(localePath(locale, "/operations"));
  redirect(`${localePath(locale, `/operations/resources/${id.toLowerCase()}`)}?result=${result}`);
}

// WPU-Z4. The switch of the unpaid-usage job on /operations/unpaid-rule. The form carries the market, the
// state asked for, the confirm box and the reason; it carries no admin, no role and no key.
export async function switchUnpaidRuleAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const answer = await makeUnpaidRuleAction(unpaidRuleFlowDeps())({
    market: text(form.get("market")),
    state: text(form.get("state")),
    confirm: text(form.get("confirm")),
    reason: text(form.get("reason")),
  });
  const result = answer.ok ? (answer.replayed ? "replayed" : "ok") : answer.code;
  redirect(`${localePath(locale, "/operations/unpaid-rule")}?result=${result}`);
}

// WPU-X3 (b). "Registry confirmed not renewed" on /payments/renewals. The form carries the renewal, the id of the form
// (a repeat of the same form is a replay) and the reason; it carries no actor and no role.
export async function confirmUnrenewedAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const answer = await makeConfirmUnrenewedAction(opsFlowDeps())({
    id: text(form.get("id")),
    requestId: text(form.get("requestId")),
    reason: text(form.get("reason")),
  });
  const result = answer.ok ? (answer.replayed ? "replayed" : "ok") : answer.code;
  redirect(`${localePath(locale, "/payments/renewals")}?result=${result}`);
}
