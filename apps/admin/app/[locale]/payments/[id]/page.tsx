import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { PaymentDetailView, resultCodeOf } from "../../../_components/MoneyViews.tsx";
import { loadPayment } from "../../../../server/money-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminMoney.payment" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 16.12 /payments/[id]. finance and superadmin open it; only finance re-verifies and records a refund
// (the repository refuses the others again).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const loaded = await loadPageAdmin(locale, "payments");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/payments/${id}`} />;
  const payment = await loadPayment(loaded.admin, id.toLowerCase());
  if (payment.kind === "missing") notFound();
  const t = await getTranslations({ locale, namespace: "AdminMoney.payments" });
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="payments">
      {payment.kind === "ok" ? (
        <PaymentDetailView
          locale={locale}
          payment={payment.value}
          canAct={loaded.admin.role === "finance"}
          canResolve={loaded.admin.role === "finance" || loaded.admin.role === "superadmin"}
          result={resultCodeOf(raw["result"])}
        />
      ) : (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      )}
    </AdminFrame>
  );
}
