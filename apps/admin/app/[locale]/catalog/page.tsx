import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { CatalogView } from "../../_components/CatalogView.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { loadPageAdmin } from "../../../server/page-admin.ts";
import { loadCatalog } from "../../../server/pricing-data.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminCatalog" });
  return { title: t("title") };
}

// 16.12 /catalog: ops and superadmin. The role guard runs first (R9 steps 1 and 2).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "catalog");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/catalog" />;
  const raw = await searchParams;
  const screen = await loadCatalog(loaded.admin, raw);
  const result = typeof raw["result"] === "string" ? raw["result"] : null;
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="catalog">
      <CatalogView locale={locale} screen={screen} result={result} />
    </AdminFrame>
  );
}
