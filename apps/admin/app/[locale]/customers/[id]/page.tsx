import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { CustomerDetailView, resultCodeOf } from "../../../_components/CustomerDetailView.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { loadCustomerDetail } from "../../../../server/customers-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCustomers" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 16.12 /customers/[id]. support, ops and superadmin open it; only ops and superadmin see the
// decisions (the repository refuses the others again).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const loaded = await loadPageAdmin(locale, "customers");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/customers/${id}`} />;
  const customer = await loadCustomerDetail(loaded.admin, id);
  if (customer.kind === "missing") notFound();
  const t = await getTranslations({ locale, namespace: "AdminCustomers" });
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="customers">
      {customer.kind === "ok" ? (
        <CustomerDetailView
          locale={locale}
          customer={customer.value}
          canAct={loaded.admin.role === "ops" || loaded.admin.role === "superadmin"}
          result={resultCodeOf(raw["result"])}
        />
      ) : (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      )}
    </AdminFrame>
  );
}
