import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { CapacityPageView, resultCodeOf } from "../../_components/OpsViews.tsx";
import { loadCapacity, recomputeQueryOf } from "../../../server/ops-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCapacity" });
  return { title: t("title") };
}

// 16.12 /capacity: pool accounts, limits and use, the waitlist. ops and superadmin open it; the
// repository checks the active admin and the role again, and a refusal shows the neutral page (R16).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "capacity");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/capacity" />;
  const raw = await searchParams;
  const recompute = recomputeQueryOf(raw);
  const data = await loadCapacity(loaded.admin, recompute);
  if (data.kind === "denied") return <NoAccess locale={locale} path="/capacity" />;
  const cell = typeof raw["cell"] === "string" ? raw["cell"] : "";
  const live = typeof raw["live"] === "string" ? raw["live"] : "";
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="capacity">
      <CapacityPageView
        locale={locale}
        data={data}
        canAct={loaded.admin.role === "ops" || loaded.admin.role === "superadmin"}
        recompute={recompute === null ? null : { cell, live }}
        result={resultCodeOf(raw["result"])}
      />
    </AdminFrame>
  );
}
