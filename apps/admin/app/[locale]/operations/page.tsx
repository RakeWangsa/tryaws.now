import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { OperationsView, resultCodeOf } from "../../_components/OpsViews.tsx";
import { loadOpsQueues, opsQueryOf } from "../../../server/ops-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminOps.queue" });
  return { title: t("title") };
}

// 16.12 /operations: the queues that need a person. ops and superadmin open it; a refusal of the
// repository (disabled admin, other role) shows the neutral page (R16).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "operations");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/operations" />;
  const raw = await searchParams;
  const query = opsQueryOf(raw);
  const queues = await loadOpsQueues(loaded.admin, query);
  if (queues.kind === "denied") return <NoAccess locale={locale} path="/operations" />;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="operations">
      <OperationsView
        locale={locale}
        query={query}
        queues={queues}
        result={resultCodeOf(raw["result"])}
      />
    </AdminFrame>
  );
}
