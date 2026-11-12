import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../../_components/AdminFrame.tsx";
import { NoAccess } from "../../../../_components/NoAccess.tsx";
import { PlanChangeDetailView, resultCodeOf } from "../../../../_components/PlanChangeView.tsx";
import { loadResourcePlan } from "../../../../../server/ops-data.ts";
import { loadPageAdmin } from "../../../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminPlanChange" });
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// WPA-P2 /operations/resources/[id]: the plan change of a container service or a CDN, and the audited
// clear of its failure mark. The guard comes first (the operations section: ops and superadmin); the
// repository checks the role again.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const loaded = await loadPageAdmin(locale, "operations");
  if (loaded.kind === "denied") {
    return <NoAccess locale={locale} path={`/operations/resources/${id}`} />;
  }
  const plan = await loadResourcePlan(loaded.admin, id.toLowerCase());
  if (plan.kind === "denied") {
    return <NoAccess locale={locale} path={`/operations/resources/${id}`} />;
  }
  if (plan.kind === "missing") notFound();
  const t = await getTranslations({ locale, namespace: "AdminPlanChange" });
  const raw = await searchParams;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="operations">
      {plan.kind === "ok" ? (
        <PlanChangeDetailView
          locale={locale}
          plan={plan.value}
          requestId={randomUUID()}
          result={resultCodeOf(raw["result"])}
        />
      ) : (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      )}
    </AdminFrame>
  );
}
