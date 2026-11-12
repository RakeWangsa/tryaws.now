import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";

/** The maintenance page (maintenance.html): one state in the public frame, with a way to the support page. */
export function MaintenanceContent({ locale }: { locale: Locale }) {
  const t = useTranslations("Public.system");
  return (
    <EmptyState
      fullPage
      title={t("maintenanceTitle")}
      description={t("maintenanceText")}
      action={
        <Button variant="primary" href={localePath(locale, "/support")}>
          {t("contactUs")}
        </Button>
      }
    />
  );
}
