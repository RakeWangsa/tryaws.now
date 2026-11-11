"use client";

import { Button, ErrorPage } from "@tc/ui";
import { useTranslations } from "next-intl";

/** The error state of /wallet (U11): a platform message, a reference id, a retry; never the error text. */
export default function WalletError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Wallet.error");
  return (
    <ErrorPage
      title={t("title")}
      message={t("body")}
      {...(error.digest !== undefined ? { referenceId: error.digest } : {})}
      retry={
        <Button variant="primary" onClick={reset}>
          {t("retry")}
        </Button>
      }
    />
  );
}
