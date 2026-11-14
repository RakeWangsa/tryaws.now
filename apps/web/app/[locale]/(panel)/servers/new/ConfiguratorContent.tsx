import { EmptyState } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { ConfiguratorScreen } from "../../../../../server/servers-view.ts";
import { ConfigForm } from "./ConfigForm.tsx";
import { AccountSetupRequired } from "../../_account/AccountSetupRequired.tsx";

// The content of /servers/new. Synchronous, so it renders in a test without a request. The states:
// flag off (R12), account setup not done (WPU-X11) (what to do next, 16.13), empty (no plan for sale) and ready.

export function ConfiguratorContent({
  locale,
  screen,
  action,
}: {
  locale: Locale;
  screen: ConfiguratorScreen;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Servers");

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
  return (
    <>
      <p className="seccolor mb-4">{t("new.intro")}</p>
      <ConfigForm
        locale={locale}
        plans={screen.plans}
        regions={screen.regions}
        keys={screen.keys}
        images={screen.images}
        action={action}
      />
    </>
  );
}
