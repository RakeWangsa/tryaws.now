"use server";

import { redirect } from "next/navigation";
import { isUuid } from "./schemas.ts";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import type { AbuseActionKind } from "./abuse-flow.ts";
import { makeAbuseAction } from "./abuse-flow.ts";
import { makeReconciliationAction } from "./reconciliation-flow.ts";
import {
  abuseFlowDeps,
  ensureAdminAuth,
  reconciliationFlowDeps,
  supportFlowDeps,
} from "./runtime.ts";
import { makeSupportAction, type SupportActionKind } from "./support-flow.ts";

// Thin Server Actions (R9 is inside the flows). A "use server" file exports async functions only. The
// kind comes from the form and is checked by the flow. The acting admin is the one of the session: no
// form field names one. The redirect goes to a page whose id has the shape of a UUID, nothing else.

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function localeOf(form: FormData) {
  const raw = text(form.get("locale"));
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

type Answer = { ok: true; replayed: boolean; sent: boolean } | { ok: false; code: string };

function resultOf(answer: Answer): string {
  if (!answer.ok) return answer.code;
  return answer.replayed ? "replayed" : answer.sent ? "ok" : "queued";
}

export async function supportAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  ensureAdminAuth();
  const id = text(form.get("id"));
  const answer = await makeSupportAction(supportFlowDeps())({
    kind: text(form.get("kind")) as SupportActionKind,
    id,
    reason: text(form.get("reason")),
    replyId: text(form.get("replyId")),
    body: text(form.get("body")),
  });
  if (!isUuid(id)) redirect(localePath(locale, "/support"));
  redirect(`${localePath(locale, `/support/${id.toLowerCase()}`)}?result=${resultOf(answer)}`);
}

export async function abuseAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  ensureAdminAuth();
  const id = text(form.get("id"));
  const answer = await makeAbuseAction(abuseFlowDeps())({
    kind: text(form.get("kind")) as AbuseActionKind,
    id,
    reason: text(form.get("reason")),
    resourceId: text(form.get("resourceId")),
    source: text(form.get("source")),
    notes: text(form.get("notes")),
    noteId: text(form.get("noteId")),
    note: text(form.get("note")),
  });
  if (!isUuid(id)) redirect(localePath(locale, "/abuse"));
  // A case that could not be opened has no page yet: back to the list with the code.
  if (!answer.ok && text(form.get("kind")) === "openAbuseCase") {
    redirect(`${localePath(locale, "/abuse")}?result=${resultOf(answer)}`);
  }
  redirect(`${localePath(locale, `/abuse/${id.toLowerCase()}`)}?result=${resultOf(answer)}`);
}

export async function reconciliationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  ensureAdminAuth();
  const answer = await makeReconciliationAction(reconciliationFlowDeps())({
    kind: "resolveDiscrepancy",
    id: text(form.get("id")),
    reason: text(form.get("reason")),
  });
  redirect(`${localePath(locale, "/reconciliation")}?result=${resultOf(answer)}`);
}
