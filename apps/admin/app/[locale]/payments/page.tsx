import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { PaymentsView, resultCodeOf } from "../../_components/MoneyViews.tsx";
import { loadOpenDiscrepancies, loadPayments, paymentQueryOf } from "../../../server/money-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminMoney.payments" });
  return { title: t("title") };
}

// 16.12 /payments: search by transaction id, the states (also review), and the payment discrepancies
// with the resolve action. finance and superadmin open it.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "payments");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/payments" />;
  const raw = await searchParams;
  const query = paymentQueryOf(raw);
  const [list, discrepancies] = await Promise.all([
    loadPayments(loaded.admin, query),
    loadOpenDiscrepancies(loaded.admin),
  ]);
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="payments">
      <PaymentsView
        locale={locale}
        query={query}
        list={list}
        discrepancies={discrepancies}
        canResolve={loaded.admin.role === "finance" || loaded.admin.role === "superadmin"}
        result={resultCodeOf(raw["result"])}
      />
    </AdminFrame>
  );
}
