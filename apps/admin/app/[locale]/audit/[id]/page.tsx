import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { AuditDetailView } from "../../../_components/AuditViews.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { loadAuditRow } from "../../../../server/audit-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminAudit.detail" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 16.12 /audit/[id]: actor, reason, IP, target, before and after, masked. Every role reads.
export default async function Page({ params }: PageProps) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const loaded = await loadPageAdmin(locale, "audit");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/audit/${id}`} />;
  const row = await loadAuditRow(loaded.admin, id.toLowerCase());
  if (row.kind === "missing") notFound();
  const t = await getTranslations({ locale, namespace: "AdminAudit.unavailable" });
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="audit">
      {row.kind === "ok" ? (
        <AuditDetailView locale={locale} row={row.value} />
      ) : (
        <EmptyState title={t("title")} description={t("body")} />
      )}
    </AdminFrame>
  );
}
