import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { PublicShell } from "@tc/ui";
import { routing } from "../../i18n/routing.ts";
import { maintenanceOn } from "../../server/public/maintenance.ts";
import { MaintenanceContent } from "./(public)/MaintenanceContent.tsx";

/**
 * A locale that is neither `bn` nor `en` is a missing page (16.7). With the maintenance switch on
 * (TC_MAINTENANCE=on) every page of the locale shows the maintenance page and nothing else runs.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  if (maintenanceOn(process.env)) {
    return (
      <PublicShell
        locale={locale}
        signedIn={false}
        openFamilies={[]}
        domainsOpen={false}
        announcement={null}
        supportPhone={null}
      >
        <MaintenanceContent locale={locale} />
      </PublicShell>
    );
  }
  return children;
}
