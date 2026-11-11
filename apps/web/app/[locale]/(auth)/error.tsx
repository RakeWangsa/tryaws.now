"use client";

import { useLocale, useTranslations } from "next-intl";
import { Button, ErrorPage } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import { AuthCard } from "./_components/AuthCard.tsx";
import { AuthPageFrame } from "./_components/AuthPageFrame.tsx";

/** The error state of the sign-in screens (U11): a platform message, a reference, a retry; never the error text. */
export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Auth");
  const locale = useLocale() === "en" ? "en" : "bn";
  return (
    <AuthPageFrame locale={locale} path="/">
      <AuthCard title={t("card.title")}>
        <ErrorPage
          title={t("state.errorTitle")}
          message={t("state.errorText")}
          {...(error.digest !== undefined ? { referenceId: error.digest } : {})}
          retry={
            <Button variant="primary" onClick={reset} className="me-3">
              {t("state.retry")}
            </Button>
          }
          home={
            <Button variant="tertiary" href={localePath(locale, "/")}>
              {t("state.home")}
            </Button>
          }
        />
      </AuthCard>
    </AuthPageFrame>
  );
}
