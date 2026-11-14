import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { OrderStatusContent } from "../orders/[id]/OrderStatusContent.tsx";
import { ReviewContent } from "../orders/review/ReviewContent.tsx";
import { SshKeysContent } from "../settings/ssh-keys/SshKeysContent.tsx";
import { ServerDetailContent } from "./[id]/ServerDetailContent.tsx";
import { ConfiguratorContent } from "./new/ConfiguratorContent.tsx";
import { ServersContent } from "./ServersContent.tsx";
import {
  configurator,
  detail,
  key,
  noopAction,
  order,
  review,
  server,
} from "./servers.fixtures.ts";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of every server
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
  (screen: Parameters<typeof ServersContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<ServersContent locale={locale} screen={screen} />, locale);
const configure =
  (screen: Parameters<typeof ConfiguratorContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<ConfiguratorContent locale={locale} screen={screen} action={noopAction} />, locale);
const reviewOf =
  (screen: Parameters<typeof ReviewContent>[0]["review"]): Renderer =>
  (locale) =>
    html(
      <ReviewContent
        locale={locale}
        review={screen}
        idempotencyKey="0190aaaa-0000-7000-8000-0000000000e1"
        action={noopAction}
      />,
      locale,
    );
const orderOf =
  (value: Parameters<typeof OrderStatusContent>[0]["order"]): Renderer =>
  (locale) =>
    html(<OrderStatusContent locale={locale} order={value} />, locale);
const detailOf =
  (value: Parameters<typeof ServerDetailContent>[0]["server"]): Renderer =>
  (locale) =>
    html(
      <ServerDetailContent locale={locale} numerals={numerals(locale)} server={value} />,
      locale,
    );
const keysOf =
  (screen: Parameters<typeof SshKeysContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(
      <SshKeysContent
        numerals={numerals(locale)}
        screen={screen}
        addAction={noopAction}
        removeAction={noopAction}
      />,
      locale,
    );
const fixed =
  (node: () => ReactElement): Renderer =>
  (locale) =>
    html(node(), locale);

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  // /servers
  "servers.ready": list({
    state: "ready",
    servers: [server(), server({ id: "x2", state: "creating", publicIp: null })],
  }),
  "servers.empty": list({ state: "ready", servers: [] }),
  "servers.flag_off": list({ state: "flag_off" }),
  "servers.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "servers.error": fixed(errorNode),
  // /servers/new
  "new.ready": configure(configurator()),
  "new.empty": configure(configurator({ plans: [], regions: [] })),
  "new.flag_off": configure({ state: "flag_off" }),
  "new.kyc_required": configure({ state: "account_setup_required", missing: ["totp"] }),
  "new.loading": fixed(() => <ScreenLoading lines={[4, 6, 2]} />),
  "new.error": fixed(errorNode),
  // /orders/review
  "review.ready": reviewOf(review()),
  "review.shortfall": reviewOf(
    review({ shortfallTaka: 190n, balanceAfterMinor: null, balanceMinor: 50001n }),
  ),
  "review.invalid": reviewOf({ state: "invalid" }),
  "review.expired": reviewOf({ state: "expired" }),
  "review.unavailable": reviewOf({ state: "unavailable" }),
  "review.loading": fixed(() => <ScreenLoading lines={[3, 5]} />),
  "review.error": fixed(errorNode),
  // /orders/[id]
  "order.creating": orderOf(order()),
  "order.ready": orderOf(order({ progress: "ready" })),
  "order.delayed": orderOf(order({ progress: "delayed" })),
  "order.failed": orderOf(order({ progress: "failed" })),
  "order.not_found": orderOf(null),
  "order.loading": fixed(() => <ScreenLoading lines={[3, 2]} />),
  "order.error": fixed(errorNode),
  // /servers/[id]
  "detail.ready": detailOf(detail()),
  "detail.pending_ip": detailOf(detail({ publicIp: null, state: "creating", keyName: null })),
  "detail.not_found": detailOf(null),
  "detail.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "detail.error": fixed(errorNode),
  // /settings/ssh-keys
  "keys.ready": keysOf({ state: "ready", keys: [key()] }),
  "keys.empty": keysOf({ state: "ready", keys: [] }),
  "keys.flag_off": keysOf({ state: "flag_off" }),
  "keys.loading": fixed(() => <ScreenLoading lines={[4, 5]} />),
  "keys.error": fixed(errorNode),
};
