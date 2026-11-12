import { PublicShell } from "@tc/ui";
import type { ProductFamily } from "@tc/ui";
import { localeHrefs } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import type { ReactNode } from "react";

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
  return (
    <PublicShell
      locale={locale}
      localeHrefs={localeHrefs(path)}
      signedIn={signedIn}
      openFamilies={openFamilies}
      domainsOpen={domainsOpen}
      announcement={null}
      supportPhone={null}
    >
      {children}
    </PublicShell>
  );
}
