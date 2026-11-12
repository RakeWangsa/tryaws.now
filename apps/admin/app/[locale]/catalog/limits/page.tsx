import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../../_components/AdminFrame.tsx";
import { NoAccess } from "../../../_components/NoAccess.tsx";
import { TierLimitsView } from "../../../_components/TierLimitsView.tsx";
import { loadPageAdmin } from "../../../../server/page-admin.ts";
import { loadTierLimits } from "../../../../server/tier-limits-data.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminTierLimits" });
  return { title: t("title") };
}

// 16.12 /catalog/limits, the limits of each risk tier: ops and superadmin, as /catalog. The role guard runs
// first (R9 steps 1 and 2); a refusal shows the neutral page and reads nothing.
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "catalog");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/catalog/limits" />;
  const raw = await searchParams;
  const screen = await loadTierLimits(loaded.admin, raw);
  const result = typeof raw["result"] === "string" ? raw["result"] : null;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="catalog">
      <TierLimitsView locale={locale} screen={screen} result={result} />
    </AdminFrame>
  );
}
