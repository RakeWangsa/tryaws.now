"use server";

import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { makeCapacityAction, type CapacityActionKind } from "./capacity-flow.ts";
import { capacityFlowDeps, ensureAdminAuth } from "./runtime.ts";

// A thin Server Action (R9 is inside makeCapacityAction). The redirect is a fixed path.

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function capacityAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const answer = await makeCapacityAction(capacityFlowDeps())({
    kind: text(form.get("kind")) as CapacityActionKind,
    reason: text(form.get("reason")),
    poolAccountId: text(form.get("poolAccountId")),
    region: text(form.get("region")),
    quotaCode: text(form.get("quotaCode")),
    limit: text(form.get("limit")),
    productFamily: text(form.get("productFamily")),
    waitlistReason: text(form.get("waitlistReason")),
    count: text(form.get("count")),
  });
  const result = answer.ok ? (answer.replayed ? "replayed" : "ok") : answer.code;
  redirect(`${localePath(locale, "/capacity")}?result=${result}`);
}
