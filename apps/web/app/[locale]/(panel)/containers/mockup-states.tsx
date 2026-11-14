import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { ContainerDetailContent } from "./[id]/ContainerDetailContent.tsx";
import { ContainersContent } from "./ContainersContent.tsx";
import { ContainerConfiguratorContent } from "./new/ContainerConfiguratorContent.tsx";
import {
  PLAN_MICRO,
  REQUEST_ID,
  configurator,
  detail,
  noopAction,
  row,
} from "./container.fixtures.ts";

// The renderers behind the rows of container-anchors.ts: one function for each state id of every
// container service screen, in the five states of U11 (loading, empty, error, flag off, ready) and the
// states that belong to one screen. Used by the anchors test and the page tests only.

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
  (screen: Parameters<typeof ContainersContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<ContainersContent locale={locale} screen={screen} />, locale);
const configure =
  (screen: Parameters<typeof ContainerConfiguratorContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(
      <ContainerConfiguratorContent locale={locale} screen={screen} action={noopAction} />,
      locale,
    );
const detailOf =
  (value: Parameters<typeof ContainerDetailContent>[0]["service"], defaultTab?: string): Renderer =>
  (locale) =>
    html(
      <ContainerDetailContent
        locale={locale}
        numerals={numerals(locale)}
        service={value}
        requestId={REQUEST_ID}
        {...(defaultTab !== undefined ? { defaultTab } : {})}
      />,
      locale,
    );
const fixed =
  (node: () => ReactElement): Renderer =>
  (locale) =>
    html(node(), locale);

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  // /containers
  "containers.ready": list({
    state: "ready",
    items: [
      row(),
      row({
        id: "0190aaaa-0000-7000-8000-0000000000d2",
        name: "worker",
        state: "creating",
        publicUrl: null,
      }),
    ],
  }),
  "containers.empty": list({ state: "ready", items: [] }),
  "containers.flag_off": list({ state: "flag_off" }),
  "containers.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "containers.error": fixed(errorNode),
  // /containers/new
  "containers_new.ready": configure(configurator()),
  "containers_new.empty": configure(configurator({ plans: [] })),
  "containers_new.flag_off": configure({ state: "flag_off" }),
  "containers_new.kyc_required": configure({ state: "account_setup_required", missing: ["totp"] }),
  "containers_new.loading": fixed(() => <ScreenLoading lines={[4, 6, 2]} />),
  "containers_new.error": fixed(errorNode),
  // /containers/[id]
  "containers_detail.ready": detailOf(detail()),
  "containers_detail.deployments": detailOf(detail(), "deployments"),
  "containers_detail.no_deployment": detailOf(
    detail({ deployment: null, runs: [], publicUrl: null, state: "creating" }),
    "deployments",
  ),
  "containers_detail.ready_pending": detailOf(
    detail({ pendingProductId: PLAN_MICRO, endpointContainer: 1 }),
    "plan",
  ),
  "containers_detail.plan_failed": detailOf(
    detail({ pendingProductId: PLAN_MICRO, pendingFailed: true }),
    "plan",
  ),
  "containers_detail.domain_issued": detailOf(
    detail({
      certificate: {
        domain: "app.example.com",
        status: "PENDING_VALIDATION",
        attached: false,
        records: [{ name: "_x.app.example.com.", type: "CNAME", value: "_y.acm.example." }],
      },
    }),
    "domain",
  ),
  "containers_detail.deploy": detailOf(detail(), "deploy"),
  "containers_detail.suspended": detailOf(detail({ state: "suspended" }), "deploy"),
  "containers_detail.not_found": detailOf(null),
  "containers_detail.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "containers_detail.error": fixed(errorNode),
};
