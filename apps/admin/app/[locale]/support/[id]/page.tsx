import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { resultCodeOf } from "../../../_components/CaseParts.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { SupportDetailView } from "../../../_components/SupportViews.tsx";
import { Unavailable } from "../../../_components/CaseParts.tsx";
import { loadSupportDetail } from "../../../../server/case-data.ts";
import { loadPageAdmin } from "../../../../server/page-admin.ts";
import { SUPPORT_REPLY_ENABLED } from "../../../../server/support-reply.ts";

type PageProps = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCases.support" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 16.12 /support/[id]: support and superadmin read, reply and close.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const loaded = await loadPageAdmin(locale, "support");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/support/${id}`} />;
  const request = await loadSupportDetail(loaded.admin, id);
  if (request.kind === "missing") notFound();
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="support">
      {request.kind === "ok" ? (
        <SupportDetailView
          locale={locale}
          request={request.value}
          result={resultCodeOf(raw["result"])}
          replyEnabled={SUPPORT_REPLY_ENABLED}
          replyId={randomUUID()}
        />
      ) : (
        <Unavailable />
      )}
    </AdminFrame>
  );
}
