import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { AdminShell, EmptyState } from "@tc/ui";
import { isLocale, localeHrefs } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";

type PageProps = { params: Promise<{ locale: string }> };

// No person yet: the sign-in with TOTP and the IP allowlist (R10) come with the admin work.
const PlaceholderAdmin = { displayName: "", role: "support" } as const;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Admin.meta" });
  return { title: t("title") };
}

function AdminHome({ locale }: { locale: Locale }) {
  const t = useTranslations("Admin.home");
  return (
    <AdminShell
      locale={locale}
      localeHrefs={localeHrefs("/")}
      currentId="today"
      admin={PlaceholderAdmin}
      visibleIds={["today"]}
    >
      <EmptyState title={t("title")} description={t("body")} />
    </AdminShell>
  );
}

export default async function Page({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <AdminHome locale={locale} />;
}
