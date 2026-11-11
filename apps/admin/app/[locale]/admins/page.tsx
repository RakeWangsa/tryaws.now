import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { AdminsView, adminResultOf } from "../../_components/AdminsViews.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { adminsAfterOf, loadAdmins } from "../../../server/admins-data.ts";
import { loadPageAdmin } from "../../../server/page-admin.ts";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "AdminUsers" });
  return { title: t("title") };
}

// 16.12 /admins: superadmin only (the guard of the section, and the repository checks again).
export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const loaded = await loadPageAdmin(locale, "admins");
  if (loaded.kind === "denied") return <NoAccess locale={locale} path="/admins" />;
  const raw = await searchParams;
  const list = await loadAdmins(loaded.admin, adminsAfterOf(raw));
  return (
    <AdminFrame locale={locale} admin={loaded.admin} currentId="admins">
      <AdminsView
        locale={locale}
        me={loaded.admin.adminId}
        list={list}
        result={adminResultOf(raw["result"])}
      />
    </AdminFrame>
  );
}
