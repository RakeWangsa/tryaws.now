import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { AuditView } from "../../_components/AuditViews.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { loadAudit } from "../../../server/audit-data.ts";
import { auditQueryOf } from "../../../server/audit-query.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminAudit" });
  return { title: t("title") };
}

// 16.12 /audit: search the audit log. Every role reads; only a superadmin downloads the CSV. Read only.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "audit");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/audit" />;
  const query = auditQueryOf(await searchParams);
  const list = await loadAudit(loaded.admin, query);
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="audit">
      <AuditView
        locale={locale}
        query={query}
        list={list}
        canExport={loaded.admin.role === "superadmin"}
      />
    </AdminFrame>
  );
}
