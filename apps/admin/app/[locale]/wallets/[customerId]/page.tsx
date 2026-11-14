import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { WalletView, resultCodeOf } from "../../../_components/MoneyViews.tsx";
import { cursorOf, loadWallet } from "../../../../server/money-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string; customerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminMoney.wallet" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 16.12 /wallets/[customerId]. finance and superadmin open it (the area of the payments); finance
// creates adjustments, finance and superadmin decide them (the repository refuses the others again).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale, customerId } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(customerId)) notFound();
  const loaded = await loadPageAdmin(locale, "payments");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/wallets/${customerId}`} />;
  const raw = await searchParams;
  const wallet = await loadWallet(loaded.admin, customerId.toLowerCase(), cursorOf(raw));
  if (wallet.kind === "missing") notFound();
  const t = await getTranslations({ locale, namespace: "AdminMoney.wallet" });
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="payments">
      {wallet.kind === "ok" ? (
        <WalletView
          locale={locale}
          wallet={wallet.value}
          adminId={loaded.admin.adminId}
          // WPU-X5 (owner decision 2026-11-14): a superadmin creates adjustments too.
          canCreate={loaded.admin.role === "finance" || loaded.admin.role === "superadmin"}
          canDecide={loaded.admin.role === "finance" || loaded.admin.role === "superadmin"}
          requestId={crypto.randomUUID()}
          result={resultCodeOf(raw["result"])}
        />
      ) : (
        <EmptyState title={t("unavailable")} description={t("unavailableBody")} />
      )}
    </AdminFrame>
  );
}
