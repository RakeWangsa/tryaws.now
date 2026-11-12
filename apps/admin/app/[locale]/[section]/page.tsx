import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { EmptyState, type AdminNavId } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import type { AdminActor } from "@tc/db";
import type { Locale } from "@tc/ui/runtime";
import { AdminFrame } from "../../_components/AdminFrame.tsx";
import { NoAccess } from "../../_components/NoAccess.tsx";
import { loadPageAdmin } from "../../../server/page-admin.ts";
import { isSectionId, segmentOf } from "../../../server/sections.ts";

type PageProps = { params: Promise<{ locale: string; section: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Admin.meta" });
  return { title: t("title") };
}

function Section({ locale, admin, id }: { locale: Locale; admin: AdminActor; id: AdminNavId }) {
  const shell = useTranslations("Shell");
  const t = useTranslations("Admin.section");
  return (
    <AdminFrame locale={locale} admin={admin} currentId={id}>
      <h2 className="h4 mergecolor">{shell(`admin.nav.${id}`)}</h2>
      <EmptyState title={t("title")} description={t("body")} />
    </AdminFrame>
  );
}

// The areas of 16.12 whose screens come later: the frame, the role guard and the navigation are
// already the real ones. R9 puts authentication first, so an unknown segment asks the guard before
// it answers: a visitor without a session goes to the sign-in (the same answer as for a known area,
// so the answer says nothing about which paths exist), a refused session sees the neutral page, and
// only a signed-in admin gets the 404. A known area that the role may not open shows the neutral
// page (R16).
export default async function Page({ params }: PageProps) {
  const { locale, section } = await params;
  if (!isLocale(locale)) notFound();
  if (!isSectionId(section) || segmentOf(section) !== section) {
    const gate = await loadPageAdmin(locale, "today");
    if (gate.kind === "denied") return <NoAccess locale={locale} path="/" />;
    notFound();
  }
  const loaded = await loadPageAdmin(locale, section);
  if (loaded.kind === "denied") return <NoAccess locale={locale} path={`/${section}`} />;
  return <Section locale={locale} admin={loaded.admin} id={section} />;
}
