import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { requirePanel } from "../../../../../server/panel.ts";
import { getRuntime } from "../../../../../server/runtime.ts";
import { loadTopUp } from "../../../../../server/topup-view.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { TopUpContent } from "./TopUpContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Wallet.topup.heading"), robots: { index: false, follow: false } };
}

/** /wallet/topup (16.10): amount, quick amounts, min and max, how you pay, payments waiting. */
export default async function TopUpPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const panel = await requirePanel("/wallet/topup");
  const screen = await loadTopUp(panel.session);

  // A configuration that cannot be read means the gateway is not open (R16), never an error page.
  const eps = await getRuntime().then(
    (runtime) => runtime.eps !== null,
    () => false,
  );

  return (
    <PanelFrame locale={locale} path="/wallet/topup" currentId="wallet" panel={panel}>
      <TopUpContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        eps={eps}
        // One key for each render of the form: a double click or a refresh-resubmit replays the same
        // payment (R7), and the Server Action refuses a key that is missing or malformed.
        initialKey={crypto.randomUUID()}
      />
    </PanelFrame>
  );
}
