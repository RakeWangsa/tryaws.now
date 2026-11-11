import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../../i18n/routing.ts";
import { requirePanel } from "../../../../../../server/panel.ts";
import { loadPayment } from "../../../../../../server/topup-view.ts";
import { PanelFrame, numeralsFor } from "../../../PanelFrame.tsx";
import { checkAgainAction } from "./actions.ts";
import { StatusContent } from "./StatusContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = { params: Promise<{ locale: string; paymentId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Wallet.topup.heading"), robots: { index: false, follow: false } };
}

/**
 * /wallet/topup/[paymentId] (16.10): the state of one payment as the server knows it. Only a row of
 * the signed-in customer is shown; another customer's id is the same "not found" as an unknown one
 * (R8). Nothing from the URL except the id is read, and the balance is the live wallet balance (R6).
 */
export default async function PaymentStatusPage({ params }: Props) {
  const { locale, paymentId } = await params;
  if (!hasLocale(routing.locales, locale) || !UUID.test(paymentId)) notFound();
  const panel = await requirePanel(`/wallet/topup/${paymentId}`);
  const found = await loadPayment(panel.session, paymentId);
  if (found === null) notFound();

  return (
    <PanelFrame
      locale={locale}
      path={`/wallet/topup/${paymentId}`}
      currentId="wallet"
      panel={panel}
    >
      <StatusContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        payment={found.payment}
        balanceMinor={found.balanceMinor}
        checkAgain={checkAgainAction.bind(null, found.payment.id)}
      />
    </PanelFrame>
  );
}
