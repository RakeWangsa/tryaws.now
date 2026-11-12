import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import type {
  DomainDetailView,
  DomainListScreen,
  DomainOrderScreen,
  DomainSearchScreen,
  TldOption,
} from "../../../../server/domain-view.ts";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { DomainDetailContent } from "./[name]/DomainDetailContent.tsx";
import { DomainsContent } from "./DomainsContent.tsx";
import { DomainOrderContent } from "./new/DomainOrderContent.tsx";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of every domain
// screen, in the five states of U11 (loading, empty, error, flag off, ready) and the states of one
// screen. Used by the mockup-anchors test and the page tests only (never imported by a page).

export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";
const noopAction = async () => ({});

export const TLDS: TldOption[] = [
  { tld: "com", decision: "auto", priceMinor: 180000n },
  { tld: "ai", decision: "review", priceMinor: 900000n },
];

export function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

type Renderer = (locale: Locale) => string;
const numerals = (locale: Locale): "beng" | "latn" => (locale === "bn" ? "beng" : "latn");
const errorNode = (): ReactElement => (
  <ScreenError error={new Error("raw text must never show")} reset={() => {}} />
);

const list =
  (search: DomainSearchScreen, items: DomainListScreen, query?: string): Renderer =>
  (locale) =>
    html(
      <DomainsContent
        locale={locale}
        numerals={numerals(locale)}
        search={search}
        list={items}
        {...(query !== undefined ? { query } : {})}
      />,
      locale,
    );
const order =
  (screen: DomainOrderScreen): Renderer =>
  (locale) =>
    html(
      <DomainOrderContent
        locale={locale}
        numerals={numerals(locale)}
        screen={screen}
        action={noopAction}
      />,
      locale,
    );
const detailOf =
  (value: DomainDetailView | null): Renderer =>
  (locale) =>
    html(
      <DomainDetailContent
        locale={locale}
        numerals={numerals(locale)}
        domain={value}
        requestId={REQUEST_ID}
      />,
      locale,
    );
const fixed =
  (node: () => ReactElement): Renderer =>
  (locale) =>
    html(node(), locale);

const OWNED = {
  items: [
    { name: "shop.com", state: "registered", expiresAt: new Date("2027-11-12T00:00:00Z") },
    { name: "wait.com", state: "awaiting_verification", expiresAt: null },
  ],
};
const DETAIL: DomainDetailView = {
  resourceId: "0190aaaa-0000-7000-8000-0000000000e1",
  name: "shop.com",
  tld: "com",
  state: "awaiting_verification",
  expiresAt: new Date("2027-11-12T00:00:00Z"),
  reachability: "pending",
  nameServers: ["ns-1.example-dns.test", "ns-2.example-dns.test"],
  autoRenew: false,
  periodEnd: new Date("2027-11-12T00:00:00Z"),
  createdAt: new Date("2026-11-12T00:00:00Z"),
};

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  // /domains
  "domains.ready": list(
    {
      state: "result",
      name: "free.com",
      tld: "com",
      availability: "available",
      decision: "auto",
      priceMinor: 180000n,
      tlds: TLDS,
    },
    { state: "ready", ...OWNED },
    "free.com",
  ),
  "domains.review": list(
    {
      state: "result",
      name: "law.ai",
      tld: "ai",
      availability: "available",
      decision: "review",
      priceMinor: 900000n,
      tlds: TLDS,
    },
    { state: "ready", ...OWNED },
    "law.ai",
  ),
  "domains.taken": list(
    {
      state: "result",
      name: "taken.com",
      tld: "com",
      availability: "unavailable",
      decision: "auto",
      priceMinor: 180000n,
      tlds: TLDS,
    },
    { state: "ready", ...OWNED },
    "taken.com",
  ),
  "domains.search_unavailable": list(
    { state: "search_unavailable", tlds: TLDS },
    { state: "ready", ...OWNED },
    "x.com",
  ),
  "domains.empty": list({ state: "idle", tlds: [] }, { state: "ready", items: [] }),
  "domains.flag_off": list({ state: "flag_off" }, { state: "flag_off" }),
  "domains.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "domains.error": fixed(errorNode),
  // /domains/new
  "domain_new.ready": order({
    state: "ready",
    name: "free.com",
    tld: "com",
    productId: "0190aaaa-0000-7000-8000-0000000000d1",
    priceMinor: 180000n,
    review: false,
  }),
  "domain_new.review": order({
    state: "ready",
    name: "law.ai",
    tld: "ai",
    productId: "0190aaaa-0000-7000-8000-0000000000d2",
    priceMinor: 900000n,
    review: true,
  }),
  "domain_new.invalid": order({ state: "invalid" }),
  "domain_new.flag_off": order({ state: "flag_off" }),
  "domain_new.kyc_required": order({ state: "kyc_required" }),
  "domain_new.loading": fixed(() => <ScreenLoading lines={[4, 6, 2]} />),
  "domain_new.error": fixed(errorNode),
  // /domains/[name]
  "domain_detail.ready": detailOf(DETAIL),
  "domain_detail.verified": detailOf({
    ...DETAIL,
    state: "registered",
    reachability: "done",
    autoRenew: true,
  }),
  "domain_detail.not_found": detailOf(null),
  "domain_detail.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "domain_detail.error": fixed(errorNode),
};
