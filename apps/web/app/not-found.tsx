import { getLocale, getTranslations } from "next-intl/server";
import { Button, EmptyState, PublicShell } from "@tc/ui";
import { DEFAULT_LOCALE, isLocale, localeHrefs, localePath } from "@tc/ui/runtime";

/** The global not-found page, in the locale of the request. */
export default async function NotFound() {
  const requested = await getLocale();
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  const t = await getTranslations({ locale });
  return (
    <PublicShell
      locale={locale}
      localeHrefs={localeHrefs("/")}
      signedIn={false}
      openFamilies={[]}
      domainsOpen={false}
      announcement={null}
      supportPhone={null}
    >
      <EmptyState
        fullPage
        title={t("Shell.notFound.title")}
        description={t("Shell.notFound.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/")}>
            {t("Shell.auth.backHome")}
          </Button>
        }
      />
    </PublicShell>
  );
}
