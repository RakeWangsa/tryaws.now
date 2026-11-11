import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { loadKitMessages } from "../messages/index.ts";
import type { Locale } from "../runtime/index.ts";
import { shellMessages } from "./messages/index.ts";

/** The provider the apps build: kit messages plus the shell messages, in Asia/Dhaka. Tests only. */
export function withIntl(node: ReactNode, locale: Locale): ReactElement {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={{ ...loadKitMessages(locale), ...shellMessages[locale] }}
      timeZone="Asia/Dhaka"
    >
      {node}
    </NextIntlClientProvider>
  );
}
