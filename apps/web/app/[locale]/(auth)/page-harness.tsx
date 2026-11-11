import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../i18n/messages.ts";

// Shared by the page tests of the sign-in screens: renders a React node with the real messages.
export function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

export const BENGALI = /[ঀ-৿]/;

/** The text of the first h2 of a page. */
export function h2Of(html: string): string {
  return /<h2[^>]*>(.*?)<\/h2>/.exec(html)?.[1]?.replace(/<[^>]+>/g, "") ?? "";
}
