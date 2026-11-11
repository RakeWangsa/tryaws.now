import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { resultCodeOf } from "../../_components/CaseParts.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { ReconciliationView } from "../../_components/ReconciliationView.tsx";
import { loadReconciliation, reconciliationQueryOf } from "../../../server/case-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCases.reconciliation" });
  return { title: t("title") };
}

// 16.12 /reconciliation: ops, finance and superadmin.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "reconciliation");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/reconciliation" />;
  const raw = await searchParams;
  const query = reconciliationQueryOf(raw);
  const data = await loadReconciliation(loaded.admin, query);
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="reconciliation">
      <ReconciliationView
        locale={locale}
        query={query}
        data={data}
        result={resultCodeOf(raw["result"])}
      />
    </AdminFrame>
  );
}
