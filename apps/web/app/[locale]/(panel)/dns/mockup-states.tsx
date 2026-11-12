import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import type { ZoneListScreen, ZoneScreen, ZoneView } from "../../../../server/dns-view.ts";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { ZoneContent } from "./[id]/ZoneContent.tsx";
import type { EditingRecord } from "./[id]/RecordForms.tsx";
import { DnsContent } from "./DnsContent.tsx";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of the DNS screens
// (loading, empty, error, flag off, ready and the states of the zone page). Used by the tests only.

export const ZONE_ID = "0190aaaa-0000-7000-8000-0000000000d1";
export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";
const noopAction = async () => ({});

export function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

type Renderer = (locale: Locale) => string;

export const LIST: ZoneListScreen = {
  state: "ready",
  zones: [
    { id: ZONE_ID, name: "example.com", state: "active", recordCount: 2 },
    {
      id: "0190aaaa-0000-7000-8000-0000000000d2",
      name: "shop.example.org",
      state: "creating",
      recordCount: null,
    },
  ],
};

export function zone(over: Partial<ZoneView> = {}): ZoneView {
  return {
    id: ZONE_ID,
    name: "example.com",
    state: "active",
    nameServers: ["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"],
    records: [
      {
        name: "example.com",
        relative: "@",
        type: "NS",
        ttl: 172800,
        values: ["ns-1.awsdns-01.org"],
        readOnly: true,
      },
      {
        name: "example.com",
        relative: "@",
        type: "TXT",
        ttl: 300,
        values: ["v=spf1 -all"],
        readOnly: false,
      },
      {
        name: "www.example.com",
        relative: "www",
        type: "A",
        ttl: 300,
        values: ["203.0.113.10", "203.0.113.11"],
        readOnly: false,
      },
    ],
    recordsStale: false,
    busy: false,
    lastChange: null,
    canEdit: true,
    requestId: REQUEST_ID,
    ...over,
  };
}

const list =
  (screen: ZoneListScreen): Renderer =>
  (locale) =>
    html(<DnsContent locale={locale} screen={screen} />, locale);
const page =
  (screen: ZoneScreen | null, editing: EditingRecord | null = null): Renderer =>
  (locale) =>
    html(
      <ZoneContent
        locale={locale}
        screen={screen}
        editing={editing}
        saveAction={noopAction}
        deleteAction={noopAction}
      />,
      locale,
    );
const ready = (over: Partial<ZoneView> = {}): ZoneScreen => ({ state: "ready", zone: zone(over) });

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "dns.ready": list(LIST),
  "dns.empty": list({ state: "empty" }),
  "dns.flag_off": list({ state: "flag_off" }),
  "dns.loading": (locale) => html(<ScreenLoading lines={[2, 4]} />, locale),
  "dns.error": (locale) =>
    html(<ScreenError error={new Error("raw text must never show")} reset={() => {}} />, locale),
  "zone.ready": page(ready()),
  "zone.editing": page(ready(), {
    relative: "www",
    type: "A",
    ttl: 300,
    values: ["203.0.113.10", "203.0.113.11"],
  }),
  "zone.working": page(ready({ busy: true, canEdit: false, lastChange: "working" })),
  "zone.failed": page(ready({ lastChange: "failed" })),
  "zone.creating": page(ready({ state: "creating", canEdit: false, nameServers: [], records: [] })),
  "zone.stale": page(ready({ records: null, recordsStale: true, canEdit: false })),
  "zone.empty_records": page(ready({ records: [] })),
  "zone.not_found": page(null),
  "zone.flag_off": page({ state: "flag_off" }),
};
