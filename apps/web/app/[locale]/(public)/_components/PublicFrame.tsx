import { PublicShell } from "@tc/ui";
import type { ProductFamily } from "@tc/ui";
import { localeHrefs } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { CONTENT_UPDATED } from "../../../../server/public/seo.ts";

/**
 * The frame of every public page: the public shell (menu, locale switch, footer with the AWS short
 * statement and the trademark line of 16.13) around the page. The families in the menu are the ones
 * whose flag is on (R12); an unreadable catalog shows none (R16).
 */
export function PublicFrame({
  locale,
  path,
  openFamilies,
  domainsOpen,
  signedIn = false,
  children,
}: {
  locale: Locale;
  /** The path without the locale prefix: the language switch points at the same page. */
  path: string;
  openFamilies: readonly ProductFamily[];
  domainsOpen: boolean;
  /** WPU-N1: a valid customer session exists; the menu then says "Console". A boolean only. */
  signedIn?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("Public");
  const format = useFormatter();
  // WPU-Z16: noon in Dhaka, so the date shown is CONTENT_UPDATED in every time zone of the formatter.
  const updated = format.dateTime(new Date(`${CONTENT_UPDATED}T12:00:00+06:00`), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    <PublicShell
      locale={locale}
      {...(path === "/" ? { localeHrefs: localeHrefs(path) } : {})}
      signedIn={signedIn}
      openFamilies={openFamilies}
      domainsOpen={domainsOpen}
      announcement={null}
      supportPhone={null}
    >
      {children}
      {/* WPU-Z16: a dated "last updated" line on every public page (the date of facts.json). */}
      <div className="container">
        <p className="small seccolor text-center my-4">
          {t.rich("updated.label", {
            date: updated,
            time: (chunks) => <time dateTime={CONTENT_UPDATED}>{chunks}</time>,
          })}
        </p>
      </div>
    </PublicShell>
  );
}
