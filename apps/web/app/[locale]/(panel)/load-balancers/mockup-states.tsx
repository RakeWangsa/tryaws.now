import type { ReactElement } from "react";
import type { Locale } from "@tc/ui/runtime";
import { errorNode, html, numeralsOf } from "../_family/render-html.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { LoadBalancerDetailContent } from "./[id]/LoadBalancerDetailContent.tsx";
import { LoadBalancersContent } from "./LoadBalancersContent.tsx";
import { LoadBalancerConfiguratorContent } from "./new/LoadBalancerConfiguratorContent.tsx";
import { REQUEST_ID, configurator, detail, noopAction, row } from "./load-balancers.fixtures.ts";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of every load
// balancer screen, in the five states of U11 (loading, empty, error, flag off, ready) and the states
// that belong to one screen. Used by the mockup-anchors test and the page tests only.

type Renderer = (locale: Locale) => string;

const list =
  (screen: Parameters<typeof LoadBalancersContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<LoadBalancersContent locale={locale} screen={screen} />, locale);
const configure =
  (screen: Parameters<typeof LoadBalancerConfiguratorContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(
      <LoadBalancerConfiguratorContent locale={locale} screen={screen} action={noopAction} />,
      locale,
    );
const detailOf =
  (
    value: Parameters<typeof LoadBalancerDetailContent>[0]["balancer"],
    extra: { targetsAction?: typeof noopAction } = {},
  ): Renderer =>
  (locale) =>
    html(
      <LoadBalancerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        balancer={value}
        requestId={REQUEST_ID}
        {...extra}
      />,
      locale,
    );
const fixed =
  (node: () => ReactElement): Renderer =>
  (locale) =>
    html(node(), locale);

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  // /load-balancers
  "lb.ready": list({
    state: "ready",
    items: [
      row(),
      row({
        id: "0190aaaa-0000-7000-8000-0000000000e2",
        name: "api",
        state: "creating",
        targetCount: 1,
      }),
    ],
  }),
  "lb.empty": list({ state: "ready", items: [] }),
  "lb.flag_off": list({ state: "flag_off" }),
  "lb.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "lb.error": fixed(errorNode),
  // /load-balancers/new
  "lb_new.ready": configure(configurator()),
  "lb_new.empty": configure(configurator({ plans: [] })),
  "lb_new.no_servers": configure(configurator({ servers: [] })),
  "lb_new.flag_off": configure({ state: "flag_off" }),
  "lb_new.kyc_required": configure({ state: "kyc_required" }),
  "lb_new.loading": fixed(() => <ScreenLoading lines={[4, 6, 2]} />),
  "lb_new.error": fixed(errorNode),
  // /load-balancers/[id]
  "lb_detail.ready": detailOf(detail()),
  "lb_detail.stopped": detailOf(detail({ state: "stopped" })),
  "lb_detail.targets_form": detailOf(detail(), { targetsAction: noopAction }),
  "lb_detail.not_found": detailOf(null),
  "lb_detail.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "lb_detail.error": fixed(errorNode),
};
