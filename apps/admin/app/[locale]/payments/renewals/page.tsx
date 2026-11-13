import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { RenewalsView, resultCodeOf } from "../../../_components/RenewalsView.tsx";
import { loadStuckRenewals } from "../../../../server/ops-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminRenewals" });
  return { title: t("title") };
}

// WPU-X3 (b) /payments/renewals: the domain renewals stuck at the registry check and the audited action "registry
// confirmed not renewed". The guard comes first (the payments section: finance and superadmin); the repository checks
// the role again.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "payments");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/payments/renewals" />;
  const list = await loadStuckRenewals(loaded.admin);
  if (list.kind === "denied") return <NoAccess locale={locale} path="/payments/renewals" />;
  const t = await getTranslations({ locale, namespace: "AdminRenewals" });
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="payments">
      {list.kind === "ok" ? (
        <RenewalsView
          locale={locale}
          rows={list.value}
          requestId={randomUUID()}
          result={resultCodeOf(raw["result"])}
        />
      ) : (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      )}
    </AdminFrame>
  );
}
