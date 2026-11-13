import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { resultCodeOf } from "../../_components/CaseParts.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { SupportListView } from "../../_components/SupportViews.tsx";
import { loadSupportList, supportQueryOf } from "../../../server/case-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCases.support" });
  return { title: t("title") };
}

// 16.12 /support: support and superadmin. WPU-Z5: open, answered and closed requests with their last activity.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "support");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/support" />;
  const raw = await searchParams;
  const query = supportQueryOf(raw);
  const list = await loadSupportList(loaded.admin, query);
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="support">
      <SupportListView
        locale={locale}
        query={query}
        list={list}
        result={resultCodeOf(raw["result"])}
      />
    </AdminFrame>
  );
}
