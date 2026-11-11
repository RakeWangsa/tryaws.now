import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { requirePanel } from "../../../../server/panel.ts";
import { bannerFor, loadWallet } from "../../../../server/wallet-view.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import { WalletContent } from "./WalletContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Wallet.meta.title"), robots: { index: false, follow: false } };
}

/** /wallet (16.10): balance, transactions with running balance, payments. */
export default async function WalletPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const panel = await requirePanel("/wallet");

  const cursor = typeof query["cursor"] === "string" ? query["cursor"].slice(0, 100) : undefined;
  const screen = await loadWallet(panel.session, cursor !== undefined ? { cursor } : {});

  return (
    <PanelFrame locale={locale} path="/wallet" currentId="wallet" panel={panel}>
      <WalletContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        banner={bannerFor(query["topup"], screen.newest)}
        hasCursor={cursor !== undefined}
      />
    </PanelFrame>
  );
}
