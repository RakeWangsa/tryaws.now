import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { DatabaseConfiguratorScreen } from "../../../../../server/databases-view.ts";
import { DatabaseConfigForm } from "./DatabaseConfigForm.tsx";

// The content of /databases/new. Synchronous, so it renders in a test without a request. The states:
// flag off (R12), KYC not verified (what to do next, 16.13), no plan for sale, and ready.

export function DatabaseConfiguratorContent({
  locale,
  screen,
  action,
}: {
  locale: Locale;
  screen: DatabaseConfiguratorScreen;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Databases");

  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.state === "kyc_required") {
    return (
      <EmptyState
        title={t("kycRequired.title")}
        description={t("kycRequired.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/support")}>
            {t("kycRequired.action")}
          </Button>
        }
      />
    );
  }
  if (screen.plans.length === 0) {
    return <EmptyState title={t("new.noPlans.title")} description={t("new.noPlans.body")} />;
  }
  return (
    <>
      <p className="seccolor mb-4">{t("new.intro")}</p>
      <DatabaseConfigForm plans={screen.plans} regions={screen.regions} action={action} />
    </>
  );
}
