"use server";

import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { makeConfigPriceFlow } from "./config-price-flow.ts";
import { makeInvoiceSellerFlow } from "./invoice-seller-flow.ts";
import { makePriceBookFlow } from "./price-book-flow.ts";
import { makeTierLimitsFlow } from "./tier-limits-flow.ts";
import { readDraft } from "./pricing-draft.ts";
import { makePricingFlow, type FlowAnswer } from "./pricing-flow.ts";
import { pricingFlowDeps } from "./pricing-runtime.ts";

// Thin Server Actions (R9 is inside makePricingFlow). A "use server" file exports async functions only.
// Nothing from the request decides the redirect except the locale (checked) and a market of two capital
// letters. The form carries no approver: the second admin of an FX change is the session of the admin
// who presses "approve".

const MARKET = /^[A-Z]{2}$/;
const FAMILY = /^[a-z][a-z_]{0,39}$/;
const CONFIG_KEY = /^config_price\.[a-z_]{1,40}$/;

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function back(
  form: FormData,
  path:
    | "/pricing"
    | "/pricing/book"
    | "/pricing/config"
    | "/pricing/seller"
    | "/catalog"
    | "/catalog/limits",
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
  // The config price page opens again on the price that was edited (a key of lower-case letters and _).
  if (path === "/pricing/config" && CONFIG_KEY.test(text(form.get("key")))) {
    query.set("key", text(form.get("key")));
  }
  // The limits page opens again on the tier that was edited.
  if (
    path === "/catalog/limits" &&
    (text(form.get("tier")) === "new" || text(form.get("tier")) === "trusted")
  ) {
    query.set("tier", text(form.get("tier")));
  }
  redirect(`${localePath(locale, path)}?${query.toString()}`);
}

function valueKind(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const kind = (value as { kind: unknown }).kind;
    // "set": a rate set by one admin alone (WPU-X9).
    return kind === "pending" || kind === "approved" || kind === "set" ? kind : null;
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
    confirmLarge: text(form.get("confirmLarge")),
  });
  back(form, "/pricing", answer);
}

export async function approveFxAction(form: FormData): Promise<void> {
  const answer = await makePricingFlow(pricingFlowDeps()).approveFx({
    market: text(form.get("market")),
    reason: text(form.get("reason")),
    confirmLarge: text(form.get("confirmLarge")),
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

// WPU-G10. The admin's minimum plan power for one image.
export async function setImageMinPowerAction(form: FormData): Promise<void> {
  const answer = await makePricingFlow(pricingFlowDeps()).setImageMinPower({
    blueprintId: text(form.get("image")),
    market: text(form.get("market")),
    minPower: text(form.get("minPower")),
    reason: text(form.get("powerReason")),
  });
  back(form, "/catalog", answer);
}

// WPU-G10. The limits of a risk tier, on /catalog/limits (the checkboxes are "on" or absent).
export async function saveTierLimitsAction(form: FormData): Promise<void> {
  const answer = await makeTierLimitsFlow(pricingFlowDeps()).saveTierLimits({
    market: text(form.get("market")),
    tier: text(form.get("tier")),
    maxInstances: text(form.get("maxInstances")),
    maxBundleUsd: text(form.get("maxBundleUsd")),
    windows: text(form.get("windows")),
    containers: text(form.get("containers")),
    maxStaticIps: text(form.get("maxStaticIps")),
    reason: text(form.get("reason")),
  });
  back(form, "/catalog/limits", answer);
}

// WPU-I1. The seller of the tax invoices (Mushak 6.3), on /pricing/seller. The form carries no actor.
export async function saveInvoiceSellerAction(form: FormData): Promise<void> {
  const answer = await makeInvoiceSellerFlow(pricingFlowDeps()).saveInvoiceSeller({
    market: text(form.get("market")),
    legalNameBn: text(form.get("legalNameBn")),
    legalNameEn: text(form.get("legalNameEn")),
    bin: text(form.get("bin")),
    addressBn: text(form.get("addressBn")),
    addressEn: text(form.get("addressEn")),
    vatCircle: text(form.get("vatCircle")),
    tradeLicense: text(form.get("tradeLicense")),
    signatoryName: text(form.get("signatoryName")),
    signatoryDesignation: text(form.get("signatoryDesignation")),
    phone: text(form.get("phone")),
    email: text(form.get("email")),
    reason: text(form.get("reason")),
  });
  back(form, "/pricing/seller", answer);
}

// WPU-G10. A config price (load balancer, snapshot, block storage, hosted zone), on /pricing/config.
export async function saveConfigPriceAction(form: FormData): Promise<void> {
  const answer = await makeConfigPriceFlow(pricingFlowDeps()).saveConfigPrice({
    market: text(form.get("market")),
    key: text(form.get("key")),
    usd: text(form.get("usd")),
    from: text(form.get("from")),
    reason: text(form.get("reason")),
  });
  back(form, "/pricing/config", answer);
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
