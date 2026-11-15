"use client";

import { Button, ErrorPage, PublicShell } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import { useLocale, useTranslations } from "next-intl";

/** The error state of the public pages (U11): a platform message, a reference, a retry; never the error text. */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Public.system");
  const locale = useLocale() === "en" ? "en" : "bn";
  return (
    <PublicShell
      locale={locale}
      signedIn={false}
      openFamilies={[]}
      domainsOpen={false}
      announcement={null}
      supportPhone={null}
    >
      <section className="sec-normal bg-colorstyle pt-150">
        <div className="container">
          <ErrorPage
            title={t("errorTitle")}
            message={t("errorText")}
            {...(error.digest !== undefined ? { referenceId: error.digest } : {})}
            retry={
              <Button variant="primary" onClick={reset} className="me-3">
                {t("retry")}
              </Button>
            }
            home={
              <Button variant="tertiary" href={localePath(locale, "/")}>
                {t("home")}
              </Button>
            }
          />
        </div>
      </section>
    </PublicShell>
  );
}
