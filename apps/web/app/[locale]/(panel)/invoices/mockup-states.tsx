import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import type { InvoiceDetailScreen, InvoiceListScreen } from "../../../../server/invoice-view.ts";
import ScreenError from "../ScreenError.tsx";
import ScreenLoading from "../ScreenLoading.tsx";
import { InvoiceDetailContent } from "./[id]/InvoiceDetailContent.tsx";
import { InvoicesContent } from "./InvoicesContent.tsx";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id of the invoice
// screens (loading, empty, error, ready, not found, lines that do not add up). Used by the tests only
// (never imported by a page).

export const INVOICE_ID = "0190aaaa-0000-7000-8000-0000000000e1";

export function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

type Renderer = (locale: Locale) => string;
const numerals = (locale: Locale): "beng" | "latn" => (locale === "bn" ? "beng" : "latn");

export const LIST: InvoiceListScreen = {
  state: "ready",
  items: [
    {
      id: INVOICE_ID,
      number: "TC-2026-000012",
      kind: "invoice",
      issuedAt: new Date("2026-11-01T06:00:00Z"),
      totalMinor: 69000n,
    },
    {
      id: "0190aaaa-0000-7000-8000-0000000000e2",
      number: "TC-2026-000011",
      kind: "invoice",
      issuedAt: new Date("2026-10-01T06:00:00Z"),
      totalMinor: 125050n,
    },
  ],
  next: "2026-11",
};

export const DETAIL: InvoiceDetailScreen = {
  state: "ready",
  seller: {
    legalNameBn: "উদাহরণ বিক্রেতা লিমিটেড",
    legalNameEn: "Example Seller Limited",
    bin: "0000000000000",
    addressBn: "ঢাকা",
    addressEn: "Dhaka",
    signatoryName: "Example Signatory",
    signatoryDesignation: "Director",
  },
  buyer: null,
  invoice: {
    id: INVOICE_ID,
    number: "TC-2026-000012",
    kind: "invoice",
    issuedAt: new Date("2026-11-01T06:00:00Z"),
    supplyAt: new Date("2026-11-01T06:00:00Z"),
    totalMinor: 69000n,
    lines: [
      {
        kind: "service",
        code: "aws",
        label: { bn: "এডব্লিউএস সেবার মূল্য", en: "AWS service price" },
        amountMinor: 60000n,
      },
      {
        kind: "step",
        code: "bd_vat",
        label: { bn: "বাংলাদেশ ভ্যাট", en: "Bangladesh VAT" },
        amountMinor: 9000n,
      },
    ],
  },
};

const list =
  (screen: InvoiceListScreen, hasCursor = false): Renderer =>
  (locale) =>
    html(
      <InvoicesContent
        locale={locale}
        numerals={numerals(locale)}
        screen={screen}
        hasCursor={hasCursor}
      />,
      locale,
    );
const detail =
  (
    screen: InvoiceDetailScreen | null,
    name = "Rahim",
    pdfNotice: "unavailable" | "not_ready" | "busy" | null = null,
  ): Renderer =>
  (locale) =>
    html(
      <InvoiceDetailContent
        locale={locale}
        numerals={numerals(locale)}
        screen={screen}
        customerName={name}
        pdfNotice={pdfNotice}
      />,
      locale,
    );

// WPU-C1: a credit note is listed with the invoices (a label of its own) and has a page of its own.
export const LIST_WITH_CREDIT: InvoiceListScreen = {
  state: "ready",
  items: [
    {
      id: "0190aaaa-0000-7000-8000-0000000000e3",
      number: "TC-CN-2026-000001",
      kind: "credit_note",
      issuedAt: new Date("2026-11-05T06:00:00Z"),
      totalMinor: 69000n,
    },
    ...(LIST.state === "ready" ? LIST.items : []),
  ],
  next: null,
};

export const DETAIL_CREDIT: InvoiceDetailScreen =
  DETAIL.state === "ready"
    ? {
        ...DETAIL,
        invoice: {
          ...DETAIL.invoice,
          id: "0190aaaa-0000-7000-8000-0000000000e3",
          number: "TC-CN-2026-000001",
          kind: "credit_note",
          issuedAt: new Date("2026-11-05T06:00:00Z"),
          supplyAt: null,
          credit: {
            originalNumber: "TC-2026-000012",
            originalIssuedAt: new Date("2026-11-01T06:00:00Z"),
            reason: "order_failed",
          },
        },
      }
    : DETAIL;

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "invoices.ready": list(LIST),
  "invoices.page2": list({ ...LIST, next: null }, true),
  "invoices.empty": list({ state: "empty" }),
  "invoices.stale_cursor": list({ state: "empty" }, true),
  "invoices.loading": (locale) => html(<ScreenLoading lines={[2, 6]} />, locale),
  "invoices.error": (locale) =>
    html(<ScreenError error={new Error("raw text must never show")} reset={() => {}} />, locale),
  "invoices.with_credit_note": list(LIST_WITH_CREDIT),
  "invoice.ready": detail(DETAIL),
  // WPU-N1: "Download PDF" gave no file; the route redirected here with a notice code.
  "invoice.pdf_unavailable": detail(DETAIL, "Rahim", "unavailable"),
  "invoice.pdf_busy": detail(DETAIL, "Rahim", "busy"),
  "invoice.credit_note": detail(DETAIL_CREDIT),
  "invoice.no_name": detail(DETAIL, ""),
  "invoice.not_found": detail(null),
  "invoice.unavailable": detail({ state: "unavailable" }),
  "invoice.seller_missing": detail({ state: "seller_missing" }),
};
