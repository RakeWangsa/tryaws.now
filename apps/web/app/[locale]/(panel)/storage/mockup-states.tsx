import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { StorageDetailContent } from "./[id]/StorageDetailContent.tsx";
import { StorageContent } from "./StorageContent.tsx";
import { StorageConfiguratorContent } from "./new/StorageConfiguratorContent.tsx";
import { REQUEST_ID, configurator, detail, noopAction, row } from "./bucket.fixtures.ts";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of every object
// storage screen, in the five states of U11 (loading, empty, error, flag off, ready) and the states
// that belong to one screen. Used by the mockup-anchors test and the page tests only.

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
  (screen: Parameters<typeof StorageContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(<StorageContent locale={locale} screen={screen} />, locale);
const configure =
  (screen: Parameters<typeof StorageConfiguratorContent>[0]["screen"]): Renderer =>
  (locale) =>
    html(
      <StorageConfiguratorContent locale={locale} screen={screen} action={noopAction} />,
      locale,
    );
const detailOf =
  (value: Parameters<typeof StorageDetailContent>[0]["bucket"], defaultTab?: string): Renderer =>
  (locale) =>
    html(
      <StorageDetailContent
        locale={locale}
        numerals={numerals(locale)}
        bucket={value}
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
  // /storage
  "storage.ready": list({
    state: "ready",
    items: [
      row(),
      row({
        id: "0190aaaa-0000-7000-8000-0000000000b2",
        name: "backups",
        bucketName: "tc-bucket-80000000000000b2",
        state: "creating",
      }),
    ],
  }),
  "storage.empty": list({ state: "ready", items: [] }),
  "storage.flag_off": list({ state: "flag_off" }),
  "storage.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "storage.error": fixed(errorNode),
  // /storage/new
  "storage_new.ready": configure(configurator()),
  "storage_new.empty": configure(configurator({ plans: [] })),
  "storage_new.flag_off": configure({ state: "flag_off" }),
  "storage_new.kyc_required": configure({ state: "account_setup_required", missing: ["totp"] }),
  "storage_new.loading": fixed(() => <ScreenLoading lines={[4, 6, 2]} />),
  "storage_new.error": fixed(errorNode),
  // /storage/[id]
  "storage_detail.ready": detailOf(detail()),
  "storage_detail.access": detailOf(detail({ accessMode: "private" }), "access"),
  "storage_detail.keys": detailOf(detail(), "keys"),
  "storage_detail.suspended": detailOf(detail({ state: "suspended" })),
  "storage_detail.destroy_open": detailOf(detail({ destroyOpen: true }), "destroy"),
  "storage_detail.not_found": detailOf(null),
  "storage_detail.loading": fixed(() => <ScreenLoading lines={[2, 6]} />),
  "storage_detail.error": fixed(errorNode),
};
