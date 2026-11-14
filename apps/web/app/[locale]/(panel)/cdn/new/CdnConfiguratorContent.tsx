import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { CdnConfiguratorScreen } from "../../../../../server/cdn-view.ts";
import { CdnConfigForm } from "./CdnConfigForm.tsx";
import { AccountSetupRequired } from "../../_account/AccountSetupRequired.tsx";

// The content of /cdn/new. Synchronous, so it renders in a test without a request. The states: flag
// off (R12), account setup not done (WPU-X11) (what to do next, 16.13), no plan for sale, no origin to put a CDN in
// front of, and ready.

export function CdnConfiguratorContent({
  locale,
  screen,
  action,
}: {
  locale: Locale;
  screen: CdnConfiguratorScreen;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Cdn");

  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.state === "account_setup_required") {
    // WPU-X11: e-mail, mobile and authenticator before buying (not KYC).
    return <AccountSetupRequired locale={locale} missing={screen.missing} />;
  }
  if (screen.plans.length === 0) {
    return <EmptyState title={t("new.noPlans.title")} description={t("new.noPlans.body")} />;
  }
  if (screen.origins.length === 0) {
    return (
      <EmptyState
        title={t("new.noOrigins.title")}
        description={t("new.noOrigins.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/servers")}>
            {t("new.noOrigins.action")}
          </Button>
        }
      />
    );
  }
  return (
    <>
      <p className="seccolor mb-4">{t("new.intro")}</p>
      <CdnConfigForm plans={screen.plans} origins={screen.origins} action={action} />
    </>
  );
}
