"use client";

import { Button, ErrorPage } from "@tc/ui";
import { useTranslations } from "next-intl";

/** The error state of a screen (U11): a platform message, a reference id, a retry; never the error text. */
export default function ScreenError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Flow.screen");
  return (
    <ErrorPage
      title={t("errorTitle")}
      message={t("errorBody")}
      {...(error.digest !== undefined ? { referenceId: error.digest } : {})}
      retry={
        <Button variant="primary" onClick={reset}>
          {t("retry")}
        </Button>
      }
    />
  );
}
