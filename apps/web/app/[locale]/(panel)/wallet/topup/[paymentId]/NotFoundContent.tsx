import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";

/** 404.html: the state of a payment that is not this customer's, or not there. Synchronous for the tests. */
export function NotFoundContent({ locale }: { locale: Locale }) {
  const t = useTranslations("Wallet.status");
  return (
    <EmptyState
      fullPage
      title={t("notFound.title")}
      description={t("notFound.body")}
      action={
        <Button variant="primary" href={localePath(locale, "/wallet")}>
          {t("backToWallet")}
        </Button>
      }
    />
  );
}
