import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { BucketConfiguratorScreen } from "../../../../../server/bucket-view.ts";
import { StorageConfigForm } from "./StorageConfigForm.tsx";

// The content of /storage/new. Synchronous, so it renders in a test without a request. The states:
// flag off (R12), KYC not verified (what to do next, 16.13), no plan for sale, and ready.

export function StorageConfiguratorContent({
  locale,
  screen,
  action,
}: {
  locale: Locale;
  screen: BucketConfiguratorScreen;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Storage");

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
      <StorageConfigForm plans={screen.plans} action={action} />
    </>
  );
}
