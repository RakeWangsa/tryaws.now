import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AbuseListView } from "../../_components/AbuseViews.tsx";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { resultCodeOf } from "../../_components/CaseParts.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { caseQueryOf, loadAbuseList } from "../../../server/case-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCases.abuse" });
  return { title: t("title") };
}

// 16.12 /abuse: ops, support and superadmin.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "abuse");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/abuse" />;
  const raw = await searchParams;
  const query = caseQueryOf(raw);
  const list = await loadAbuseList(loaded.admin, query);
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="abuse">
      <AbuseListView
        locale={locale}
        query={query}
        list={list}
        result={resultCodeOf(raw["result"])}
        newCaseId={randomUUID()}
      />
    </AdminFrame>
  );
}
