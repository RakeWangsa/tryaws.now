import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import { screen } from "./wallet.fixtures.ts";
import { WalletContent } from "./WalletContent.tsx";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id. Used by the
// mockup-anchors test only. Task 7 adds the states of the top-up and the status pages here.

export function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

type Renderer = (locale: Locale) => string;

const wallet =
  (
    over: Parameters<typeof screen>[0],
    banner: Parameters<typeof WalletContent>[0]["banner"],
  ): Renderer =>
  (locale) =>
    html(
      <WalletContent
        locale={locale}
        numerals={locale === "bn" ? "beng" : "latn"}
        screen={screen(over)}
        banner={banner}
        hasCursor={false}
      />,
      locale,
    );

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "wallet.data": wallet({ waitingCount: 1 }, null),
  "wallet.empty": wallet({ lines: [], payments: [], newest: null }, null),
  "wallet.banner.checking": wallet({}, "checking"),
  "wallet.banner.credited": wallet({}, "credited"),
  "wallet.banner.cancelled": wallet({}, "cancelled"),
  "wallet.banner.expired": wallet({}, "expired"),
  "wallet.banner.failed": wallet({}, "failed"),
  "wallet.banner.unknown": wallet({}, "unknown"),
};
