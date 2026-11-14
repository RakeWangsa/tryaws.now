import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { DomainOrderScreen } from "../../../../../server/domain-view.ts";
import { DomainOrderForm } from "./DomainOrderForm.tsx";
import { AccountSetupRequired } from "../../_account/AccountSetupRequired.tsx";

// The content of /domains/new. Synchronous, so it renders in a test without a request. The states:
// flag off (R12), account setup not done (WPU-X11) (16.13), a name that is not valid or not for sale, and ready.

export function DomainOrderContent({
  locale,
  numerals,
  screen,
  action,
}: {
  locale: Locale;
  numerals: "beng" | "latn";
  screen: DomainOrderScreen;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Domains");

  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.state === "account_setup_required") {
    // WPU-X11: e-mail, mobile and authenticator before buying (not KYC).
    return <AccountSetupRequired locale={locale} missing={screen.missing} />;
  }
  if (screen.state === "invalid") {
    return (
      <EmptyState
        title={t("new.invalid.title")}
        description={t("new.invalid.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/domains")}>
            {t("new.invalid.action")}
          </Button>
        }
      />
    );
  }
  return (
    <>
      <p className="seccolor mb-4">{t("new.intro")}</p>
      <DomainOrderForm
        name={screen.name}
        priceMinor={screen.priceMinor}
        review={screen.review}
        numerals={numerals}
        action={action}
      />
    </>
  );
}
