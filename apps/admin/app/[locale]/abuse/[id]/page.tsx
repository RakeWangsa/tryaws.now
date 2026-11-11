import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AbuseDetailView } from "../../../_components/AbuseViews.tsx";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { resultCodeOf, Unavailable } from "../../../_components/CaseParts.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { loadAbuseDetail } from "../../../../server/case-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCases.abuse" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 16.12 /abuse/[id]. ops, support and superadmin work the case; only ops and superadmin see the
// suspension (the repository refuses the others again).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const loaded = await loadPageAdmin(locale, "abuse");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/abuse/${id}`} />;
  const found = await loadAbuseDetail(loaded.admin, id);
  if (found.kind === "missing") notFound();
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="abuse">
      {found.kind === "ok" ? (
        <AbuseDetailView
          locale={locale}
          abuse={found.value}
          result={resultCodeOf(raw["result"])}
          canSuspend={loaded.admin.role === "ops" || loaded.admin.role === "superadmin"}
          newNoteId={randomUUID()}
        />
      ) : (
        <Unavailable />
      )}
    </AdminFrame>
  );
}
