import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { OperationDetailView, resultCodeOf } from "../../../_components/OpsViews.tsx";
import { loadOperation } from "../../../../server/ops-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminOps.detail" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 16.12 /operations/[id]: the facts and the decisions. The actions shown are the ones the stored state
// allows; the Server Action checks the state again in its own transaction.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const loaded = await loadPageAdmin(locale, "operations");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/operations/${id}`} />;
  const operation = await loadOperation(loaded.admin, id.toLowerCase());
  if (operation.kind === "denied") return <NoAccess locale={locale} path={`/operations/${id}`} />;
  if (operation.kind === "missing") notFound();
  const t = await getTranslations({ locale, namespace: "AdminOps.detail" });
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="operations">
      {operation.kind === "ok" ? (
        <OperationDetailView
          locale={locale}
          operation={operation.value}
          result={resultCodeOf(raw["result"])}
        />
      ) : (
        <EmptyState title={t("unavailable")} description={t("back")} />
      )}
    </AdminFrame>
  );
}
