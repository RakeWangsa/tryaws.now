import type { ReactElement } from "react";
import type { Locale } from "@tc/ui/runtime";
import { errorNode, html, numeralsOf } from "../_family/render-html.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { DatabaseDetailContent } from "./[id]/DatabaseDetailContent.tsx";
import { DatabasesContent } from "./DatabasesContent.tsx";
import { DatabaseConfiguratorContent } from "./new/DatabaseConfiguratorContent.tsx";
import { REQUEST_ID, configurator, detail, noopAction, row } from "./databases.fixtures.ts";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of every database
// screen, in the five states of U11 (loading, empty, error, flag off, ready) and the states that belong
// to one screen. Used by the mockup-anchors test and the page tests only.

type Renderer = (locale: Locale) => string;

const list =
  (screen: Parameters<typeof DatabasesContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<DatabasesContent locale={locale} screen={screen} />, locale);
const configure =
  (screen: Parameters<typeof DatabaseConfiguratorContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(
      <DatabaseConfiguratorContent locale={locale} screen={screen} action={noopAction} />,
      locale,
    );
const detailOf =
  (
    value: Parameters<typeof DatabaseDetailContent>[0]["database"],
    extra: { initialSecret?: { username: string; password: string } } = {},
  ): Renderer =>
  (locale) =>
    html(
      <DatabaseDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        database={value}
        requestId={REQUEST_ID}
        {...extra}
      />,
      locale,
    );
const fixed =
  (node: () => ReactElement): Renderer =>
  (locale) =>
    html(node(), locale);

/** A password that is only ever used in the test of the Connect tab. */
export const TEST_SECRET = { username: "tcadmin", password: "Zq7-test-only-secret" };

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  // /databases
  "databases.ready": list({
    state: "ready",
    items: [
      row(),
      row({
        id: "0190aaaa-0000-7000-8000-0000000000d2",
        name: "reports-db",
        state: "creating",
        endpoint: null,
        port: null,
        specs: { engine: "postgres", version: "16" },
      }),
    ],
  }),
  "databases.empty": list({ state: "ready", items: [] }),
  "databases.flag_off": list({ state: "flag_off" }),
  "databases.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "databases.error": fixed(errorNode),
  // /databases/new
  "databases_new.ready": configure(configurator()),
  "databases_new.empty": configure(configurator({ plans: [] })),
  "databases_new.flag_off": configure({ state: "flag_off" }),
  "databases_new.kyc_required": configure({ state: "account_setup_required", missing: ["totp"] }),
  "databases_new.loading": fixed(() => <ScreenLoading lines={[4, 6, 2]} />),
  "databases_new.error": fixed(errorNode),
  // /databases/[id]
  "databases_detail.ready": detailOf(detail()),
  "databases_detail.pending_endpoint": detailOf(
    detail({ state: "creating", endpoint: null, port: null, backups: [] }),
  ),
  "databases_detail.stopped": detailOf(detail({ state: "stopped" })),
  "databases_detail.secret": detailOf(detail(), { initialSecret: TEST_SECRET }),
  "databases_detail.not_found": detailOf(null),
  "databases_detail.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "databases_detail.error": fixed(errorNode),
};
