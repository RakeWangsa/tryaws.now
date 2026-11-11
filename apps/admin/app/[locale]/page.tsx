import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import type { AdminActor } from "@tc/db";
import type { Locale } from "@tc/ui/runtime";
import { AdminFrame } from "../_components/AdminFrame.tsx";
import { NoAccess } from "../_components/NoAccess.tsx";
import { loadPageAdmin } from "../../server/page-admin.ts";

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Admin.meta" });
  return { title: t("title") };
}

function AdminHome({ locale, admin }: { locale: Locale; admin: AdminActor }) {
  const t = useTranslations("Admin.home");
  return (
    <AdminFrame locale={locale} admin={admin} currentId="today">
      <EmptyState title={t("title")} description={t("body")} />
    </AdminFrame>
  );
}

// 16.12 `/`: Today, for every role. The summary tiles come with the screens that own their data.
export default async function Page({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "today");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/" />;
  return <AdminHome locale={locale} admin={loaded.admin} />;
}
