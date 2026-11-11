import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import { NotFoundContent } from "./topup/[paymentId]/NotFoundContent.tsx";
import { StatusContent } from "./topup/[paymentId]/StatusContent.tsx";
import { TopUpContent } from "./topup/TopUpContent.tsx";
import { TopUpFormView } from "./topup/TopUpForm.tsx";
import { payment, screen } from "./wallet.fixtures.ts";
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

const numeralsOf = (locale: Locale) => (locale === "bn" ? "beng" : "latn");
const RANGE = { minMinor: 10000n, maxMinor: 5000000n };

const topup =
  (over: {
    quick?: bigint[];
    market?: null;
    eps?: boolean;
    open?: ReturnType<typeof payment>[];
  }): Renderer =>
  (locale) =>
    html(
      <TopUpContent
        locale={locale}
        numerals={numeralsOf(locale)}
        screen={{
          market: over.market === null ? null : ({ code: "BD" } as never),
          range: RANGE,
          quick: over.quick ?? [50000n, 100000n, 500000n],
          open: over.open ?? [payment({ status: "redirected" })],
        }}
        eps={over.eps ?? true}
        initialKey="key-0123456789"
      />,
      locale,
    );

const topupError =
  (code: "unavailable" | "rate_limited"): Renderer =>
  (locale) =>
    html(
      <TopUpFormView
        locale={locale}
        numerals={numeralsOf(locale)}
        range={RANGE}
        quick={[]}
        state={{
          status: "error",
          idempotencyKey: "key-0123456789",
          code,
          retryAfterSeconds: 30,
          requestId: "abcd1234",
        }}
        text="1500"
        onText={() => {}}
        onFormChange={() => {}}
        formAction={() => {}}
      />,
      locale,
    );

const status =
  (rowStatus: string): Renderer =>
  (locale) =>
    html(
      <StatusContent
        locale={locale}
        numerals={numeralsOf(locale)}
        payment={payment({ status: rowStatus })}
        balanceMinor={150000n}
        checkAgain={() => {}}
      />,
      locale,
    );

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "topup.form": topup({}),
  "topup.form.noquick": topup({ quick: [], open: [] }),
  "topup.error.unavailable": topupError("unavailable"),
  "topup.error.rate_limited": topupError("rate_limited"),
  "topup.closed": topup({ market: null }),
  "topup.closed.noeps": topup({ eps: false }),
  "status.credited": status("credited"),
  "status.pending": status("redirected"),
  "status.review": status("review"),
  "status.failed": status("failed"),
  "status.cancelled": status("cancelled"),
  "status.expired": status("expired"),
  "status.notfound": (locale) => html(<NotFoundContent locale={locale} />, locale),
  "wallet.data": wallet({ waitingCount: 1 }, null),
  "wallet.empty": wallet({ lines: [], payments: [], newest: null }, null),
  "wallet.banner.checking": wallet({}, "checking"),
  "wallet.banner.credited": wallet({}, "credited"),
  "wallet.banner.cancelled": wallet({}, "cancelled"),
  "wallet.banner.expired": wallet({}, "expired"),
  "wallet.banner.failed": wallet({}, "failed"),
  "wallet.banner.unknown": wallet({}, "unknown"),
};
