"use server";

import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { makePriceBookFlow } from "./price-book-flow.ts";
import { readDraft } from "./pricing-draft.ts";
import { makePricingFlow, type FlowAnswer } from "./pricing-flow.ts";
import { pricingFlowDeps } from "./pricing-runtime.ts";

// Thin Server Actions (R9 is inside makePricingFlow). A "use server" file exports async functions only.
// Nothing from the request decides the redirect except the locale (checked) and a market of two capital
// letters. The form carries no approver: the second admin of an FX change is the session of the admin
// who presses "approve".

const MARKET = /^[A-Z]{2}$/;
const FAMILY = /^[a-z][a-z_]{0,39}$/;

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function back(
  form: FormData,
  path: "/pricing" | "/pricing/book" | "/catalog",
  answer: FlowAnswer<unknown>,
): never {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const market = MARKET.test(text(form.get("market"))) ? text(form.get("market")) : "";
  const result = answer.ok
    ? answer.replayed
      ? "replayed"
      : (valueKind(answer.value) ?? "ok")
    : answer.code;
  const query = new URLSearchParams({ result });
  if (market !== "") query.set("market", market);
  // The price list opens again on the family that was edited (a name of lower-case letters only).
  if (path === "/pricing/book" && FAMILY.test(text(form.get("family")))) {
    query.set("family", text(form.get("family")));
  }
  redirect(`${localePath(locale, path)}?${query.toString()}`);
}

function valueKind(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const kind = (value as { kind: unknown }).kind;
    return kind === "pending" || kind === "approved" ? kind : null;
  }
  return null;
}

export async function saveRuleAction(form: FormData): Promise<void> {
  const draft = readDraft((name) => text(form.get(name)), "BD");
  const answer = await makePricingFlow(pricingFlowDeps()).saveRule({
    market: draft.market,
    family: draft.family,
    steps: draft.steps.map((s) => ({
      code: s.code,
      rate: s.rate,
      base: s.base,
      bn: s.bn,
      en: s.en,
    })),
    from: draft.from,
    reason: text(form.get("reason")),
  });
  back(form, "/pricing", answer);
}

export async function setFxAction(form: FormData): Promise<void> {
  const answer = await makePricingFlow(pricingFlowDeps()).setFx({
    market: text(form.get("market")),
    rate: text(form.get("rate")),
    from: text(form.get("from")),
    reason: text(form.get("reason")),
  });
  back(form, "/pricing", answer);
}

export async function approveFxAction(form: FormData): Promise<void> {
  const answer = await makePricingFlow(pricingFlowDeps()).approveFx({
    market: text(form.get("market")),
    reason: text(form.get("reason")),
  });
  back(form, "/pricing", answer);
}

export async function setFlagAction(form: FormData): Promise<void> {
  const turn = text(form.get("turn"));
  const answer = await makePricingFlow(pricingFlowDeps()).setFlag({
    key: text(form.get("key")),
    market: text(form.get("market")),
    enabled: turn === "on" ? true : turn === "off" ? false : null,
    reason: text(form.get("reason")),
  });
  back(form, "/catalog", answer);
}

export async function setImageAction(form: FormData): Promise<void> {
  const turn = text(form.get("imageTurn"));
  const answer = await makePricingFlow(pricingFlowDeps()).setImage({
    blueprintId: text(form.get("image")),
    market: text(form.get("market")),
    enabled: turn === "on" ? true : turn === "off" ? false : null,
    reason: text(form.get("imageReason")),
  });
  back(form, "/catalog", answer);
}

export async function saveBookAction(form: FormData): Promise<void> {
  const answer = await makePriceBookFlow(pricingFlowDeps()).saveBook({
    market: text(form.get("market")),
    family: text(form.get("family")),
    marginKind: text(form.get("marginKind")),
    margin: text(form.get("margin")),
    commissionKind: text(form.get("commissionKind")),
    commission: text(form.get("commission")),
    from: text(form.get("from")),
    reason: text(form.get("reason")),
  });
  back(form, "/pricing/book", answer);
}

export async function setBaseCostAction(form: FormData): Promise<void> {
  const answer = await makePriceBookFlow(pricingFlowDeps()).setBaseCost({
    market: text(form.get("market")),
    family: text(form.get("family")),
    catalogProductId: text(form.get("product")),
    awsPriceUsd: text(form.get("usd")),
    reason: text(form.get("reason")),
  });
  back(form, "/pricing/book", answer);
}
