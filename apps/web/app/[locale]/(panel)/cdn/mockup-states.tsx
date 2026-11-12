import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { CdnDetailContent } from "./[id]/CdnDetailContent.tsx";
import { CdnContent } from "./CdnContent.tsx";
import { CdnConfiguratorContent } from "./new/CdnConfiguratorContent.tsx";
import {
  PLAN_MEDIUM,
  REQUEST_ID,
  configurator,
  detail,
  noopAction,
  origin,
  row,
} from "./cdn.fixtures.ts";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of every CDN
// screen, in the five states of U11 (loading, empty, error, flag off, ready) and the states that
// belong to one screen. Used by the mockup-anchors test and the page tests only.

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
  (screen: Parameters<typeof CdnContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<CdnContent locale={locale} screen={screen} />, locale);
const configure =
  (screen: Parameters<typeof CdnConfiguratorContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<CdnConfiguratorContent locale={locale} screen={screen} action={noopAction} />, locale);
const detailOf =
  (value: Parameters<typeof CdnDetailContent>[0]["cdn"]): Renderer =>
  (locale) =>
    html(
      <CdnDetailContent
        locale={locale}
        numerals={numerals(locale)}
        cdn={value}
        requestId={REQUEST_ID}
      />,
      locale,
    );
const fixed =
  (node: () => ReactElement): Renderer =>
  (locale) =>
    html(node(), locale);

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  // /cdn
  "cdn.ready": list({
    state: "ready",
    items: [
      row(),
      row({
        id: "0190aaaa-0000-7000-8000-0000000000c2",
        name: "assets-cdn",
        state: "creating",
        originKind: "bucket",
        originName: "assets",
        defaultDomain: null,
      }),
    ],
  }),
  "cdn.empty": list({ state: "ready", items: [] }),
  "cdn.flag_off": list({ state: "flag_off" }),
  "cdn.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "cdn.error": fixed(errorNode),
  // /cdn/new
  "cdn_new.ready": configure(configurator()),
  "cdn_new.empty": configure(configurator({ plans: [] })),
  "cdn_new.no_origin": configure(configurator({ origins: [] })),
  "cdn_new.flag_off": configure({ state: "flag_off" }),
  "cdn_new.kyc_required": configure({ state: "kyc_required" }),
  "cdn_new.loading": fixed(() => <ScreenLoading lines={[4, 6, 2]} />),
  "cdn_new.error": fixed(errorNode),
  // /cdn/[id]
  "cdn_detail.ready": detailOf(detail()),
  "cdn_detail.pending_domain": detailOf(detail({ state: "creating", defaultDomain: null })),
  "cdn_detail.stopped": detailOf(detail({ state: "stopped" })),
  "cdn_detail.pending_plan": detailOf(detail({ pendingProductId: PLAN_MEDIUM })),
  "cdn_detail.cache_saved": detailOf(
    detail({
      cachePolicy: {
        defaultBehavior: "cache",
        defaultTtl: 3600,
        minimumTtl: 0,
        maximumTtl: 86400,
        allowedHttpMethods: "GET,HEAD",
        cachedHttpMethods: "GET,HEAD",
        cookies: "none",
        headers: "none",
        queryStrings: false,
        paths: [{ path: "images/*", behavior: "cache" }],
      },
    }),
  ),
  "cdn_detail.domain_pending": detailOf(
    detail({
      certificate: {
        domain: "cdn.example.com",
        status: "PENDING_VALIDATION",
        attached: false,
        records: [{ name: "_a.cdn.example.com.", type: "CNAME", value: "_b.acm.example." }],
      },
    }),
  ),
  "cdn_detail.no_other_origin": detailOf(detail({ origins: [origin()], plans: null })),
  "cdn_detail.not_found": detailOf(null),
  "cdn_detail.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "cdn_detail.error": fixed(errorNode),
};
