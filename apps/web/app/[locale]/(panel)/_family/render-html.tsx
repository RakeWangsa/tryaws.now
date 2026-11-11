import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import ScreenError from "../ScreenError.tsx";

// Static markup of a screen state in one locale, with the real messages. Used by the render tests and
// the mockup cross-check only (never by a page).

export function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

export const numeralsOf = (locale: Locale): "beng" | "latn" => (locale === "bn" ? "beng" : "latn");

/** The error boundary with a message that must never reach the page. */
export const errorNode = (): ReactElement => (
  <ScreenError error={new Error("raw text must never show")} reset={() => {}} />
);
