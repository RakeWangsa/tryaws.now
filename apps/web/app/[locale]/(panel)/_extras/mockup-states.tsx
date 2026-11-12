import type { ReactElement } from "react";
import type { Locale } from "@tc/ui/runtime";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { DashboardContent } from "../dashboard/DashboardContent.tsx";
import { NotificationsContent } from "../notifications/NotificationsContent.tsx";
import { ServerDetailContent } from "../servers/[id]/ServerDetailContent.tsx";
import { detail } from "../servers/servers.fixtures.ts";
import { html } from "../servers/mockup-states.tsx";
import {
  bundle,
  dashboard,
  emptyDashboard,
  extras,
  noopActions,
  notifications,
} from "./extras.fixtures.ts";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of the screens of
// WP5-T6, in the states of U11 (loading, empty, error, flag off, ready) and the states that belong to
// one tab. Used by the mockup-anchors test and the page tests only.

type Renderer = (locale: Locale) => string;
const numerals = (locale: Locale): "beng" | "latn" => (locale === "bn" ? "beng" : "latn");
const errorNode = (): ReactElement => (
  <ScreenError error={new Error("raw text must never show")} reset={() => {}} />
);

const dash =
  (view: Parameters<typeof DashboardContent>[0]["view"], flagOff = false): Renderer =>
  (locale) =>
    html(
      <DashboardContent
        locale={locale}
        numerals={numerals(locale)}
        view={view}
        flagOff={flagOff}
      />,
      locale,
    );
const notes =
  (screen: Parameters<typeof NotificationsContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(
      <NotificationsContent
        locale={locale}
        numerals={numerals(locale)}
        screen={screen}
        action={async () => ({})}
      />,
      locale,
    );
const tabs =
  (options: Parameters<typeof bundle>[0] = {}): Renderer =>
  (locale) =>
    html(
      <ServerDetailContent
        locale={locale}
        numerals={numerals(locale)}
        server={detail()}
        extras={bundle(options)}
      />,
      locale,
    );

export const STATE_RENDERERS: Record<string, Renderer> = {
  "dashboard.ready": dash(dashboard()),
  "dashboard.empty": dash(emptyDashboard),
  "dashboard.flag_off": dash(dashboard(), true),
  "dashboard.loading": (locale) => html(<ScreenLoading lines={[2, 4, 4]} />, locale),
  "dashboard.error": (locale) => html(errorNode(), locale),
  "notifications.ready": notes(notifications()),
  "notifications.empty": notes(notifications({ items: [], unread: 0 })),
  "notifications.loading": (locale) => html(<ScreenLoading lines={[6]} />, locale),
  "notifications.error": (locale) => html(errorNode(), locale),
  "tabs.ready": tabs(),
  "tabs.backups_empty": tabs({ data: { backups: [] } }),
  "tabs.storage_empty": tabs({ data: { disks: [], freeDisks: [] } }),
  "tabs.metrics_unavailable": tabs({ metrics: { state: "unavailable" } }),
  "tabs.metrics_empty": tabs({ metrics: { state: "empty", range: "1d" } }),
  "tabs.billing_none": tabs({
    data: {
      billing: {
        status: null,
        periodStart: null,
        periodEnd: null,
        autoRenew: false,
        lines: null,
        invoices: [],
        renewalWait: null,
      },
    },
  }),
  "tabs.destroy_blocked": tabs({
    data: { destroy: { allowed: false, manualBackups: 0, retentionDays: 14 } },
  }),
  "tabs.not_live": tabs({ data: { live: false, canBackup: false, state: "creating" } }),
  "tabs.loading": (locale) => html(<ScreenLoading lines={[2, 6]} />, locale),
  "tabs.error": (locale) => html(errorNode(), locale),
};

// extras and noopActions are re-exported for the page tests.
export { extras, noopActions };
