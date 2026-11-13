import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../i18n/messages.ts";
import { FAMILY_PAGES } from "../../../server/public/indexing.ts";
import type { LegalDoc } from "../../../server/public/indexing.ts";
import type { PublicCatalog } from "../../../server/public/catalog.ts";
import { PublicFrame } from "./_components/PublicFrame.tsx";
import { menuOf } from "./_components/page.ts";
import { HomeContent } from "./HomeContent.tsx";
import { MaintenanceContent } from "./MaintenanceContent.tsx";
import { HelpContent } from "./help/HelpContent.tsx";
import { LegalContent } from "./legal/LegalContent.tsx";
import { PricingContent } from "./pricing/PricingContent.tsx";
import { FamilyContent } from "./products/[family]/FamilyContent.tsx";
import { CloudServersContent } from "./products/cloud-servers/CloudServersContent.tsx";
import { SupportContent } from "./support/SupportContent.tsx";
import { NONCE, ORIGIN } from "./public.fixtures.ts";

// The renderers behind the tests of the public pages: one function for each state id, each page
// inside the public frame (the shell with the AWS statement and the trademark line, 16.13).

export function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

export type Renderer = (locale: Locale) => string;

const base = { origin: ORIGIN, nonce: NONCE };

export function framed(
  catalog: PublicCatalog,
  path: string,
  content: (locale: Locale) => ReactElement,
): Renderer {
  return (locale) =>
    html(
      <PublicFrame locale={locale} path={path} {...menuOf(catalog)}>
        {content(locale)}
      </PublicFrame>,
      locale,
    );
}

/** Every public page and state, for a catalog that has Cloud Server and Managed Database open. */
export function renderers(
  open: PublicCatalog,
  unavailable: PublicCatalog,
): Record<string, Renderer> {
  const out: Record<string, Renderer> = {
    "home.data": framed(open, "/", (locale) => (
      <HomeContent locale={locale} catalog={open} {...base} />
    )),
    "home.unavailable": framed(unavailable, "/", (locale) => (
      <HomeContent locale={locale} catalog={unavailable} {...base} />
    )),
    "pricing.data": framed(open, "/pricing", (locale) => (
      <PricingContent locale={locale} catalog={open} {...base} />
    )),
    "pricing.unavailable": framed(unavailable, "/pricing", (locale) => (
      <PricingContent locale={locale} catalog={unavailable} {...base} />
    )),
    "cloud.data": framed(open, "/products/cloud-servers", (locale) => (
      <CloudServersContent locale={locale} catalog={open} {...base} />
    )),
    "cloud.unavailable": framed(unavailable, "/products/cloud-servers", (locale) => (
      <CloudServersContent locale={locale} catalog={unavailable} {...base} />
    )),
    "help.data": framed(open, "/help", (locale) => <HelpContent locale={locale} {...base} />),
    "support.data": framed(open, "/support", (locale) => (
      <SupportContent locale={locale} {...base} />
    )),
    "maintenance.data": framed(open, "/", (locale) => <MaintenanceContent locale={locale} />),
  };
  for (const doc of ["terms", "privacy", "acceptable-use", "refund"] as LegalDoc[]) {
    out[`legal.${doc}`] = framed(open, `/legal/${doc}`, (locale) => (
      <LegalContent locale={locale} doc={doc} {...base} />
    ));
  }
  const page = FAMILY_PAGES[0]!;
  out["family.soon"] = framed(open, `/products/${page.slug}`, (locale) => (
    <FamilyContent locale={locale} page={page} open={false} {...base} />
  ));
  out["family.open"] = framed(open, `/products/${page.slug}`, (locale) => (
    <FamilyContent locale={locale} page={page} open {...base} />
  ));
  return out;
}
