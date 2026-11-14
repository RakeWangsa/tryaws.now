import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { LoadBalancerConfiguratorScreen } from "../../../../../server/load-balancers-view.ts";
import { LoadBalancerConfigForm } from "./LoadBalancerConfigForm.tsx";
import { AccountSetupRequired } from "../../_account/AccountSetupRequired.tsx";

// The content of /load-balancers/new. Synchronous, so it renders in a test without a request. The
// states: flag off (R12), account setup not done (WPU-X11) (what to do next, 16.13), no plan for sale, no server to
// use as a target, and ready.

export function LoadBalancerConfiguratorContent({
  locale,
  screen,
  action,
}: {
  locale: Locale;
  screen: LoadBalancerConfiguratorScreen;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("LoadBalancers");

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
  if (screen.servers.length === 0) {
    return (
      <EmptyState
        title={t("new.noServers.title")}
        description={t("new.noServers.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/servers")}>
            {t("new.noServers.action")}
          </Button>
        }
      />
    );
  }
  return (
    <>
      <p className="seccolor mb-4">{t("new.intro")}</p>
      <LoadBalancerConfigForm plans={screen.plans} servers={screen.servers} action={action} />
    </>
  );
}
