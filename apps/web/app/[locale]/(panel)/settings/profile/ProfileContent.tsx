import { Button, Card, EmptyState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { ProfileScreen } from "../../../../../server/settings-view.ts";
import { BillingForm, DetailsForm, EmailChange, PhoneChange } from "./ProfileForms.tsx";

// The content of /settings/profile: name and language, then e-mail and phone, each changed in two
// steps behind a fresh sign-in (6.1). Synchronous, so it renders in a test without a request. When
// the provider adapters are not configured, the two sensitive cards show the "not open" state.

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export interface ProfileActions {
  updateProfile: Action;
  updateBilling: Action;
  startEmail: Action;
  confirmEmail: Action;
  startPhone: Action;
  confirmPhone: Action;
}

export function ProfileContent({
  screen,
  actions,
  signInHref,
  securityHref,
}: {
  screen: ProfileScreen;
  actions: ProfileActions;
  signInHref: string;
  securityHref: string;
}) {
  const t = useTranslations("Settings");
  const notOpen = <EmptyState title={t("notOpen.title")} description={t("notOpen.body")} />;
  return (
    <>
      <p className="seccolor mb-2">{t("profile.intro")}</p>
      <p className="seccolor mb-4">
        <i className="fas fa-shield-alt me-2" aria-hidden="true" />
        {t("fresh.note")}
      </p>
      <Card title={t("profile.details.title")} className="mb-4">
        <DetailsForm
          action={actions.updateProfile}
          name={screen.name}
          locale={screen.locale}
          signInHref={signInHref}
        />
      </Card>
      <Card title={t("profile.billing.title")} className="mb-4">
        <p className="seccolor mb-3">{t("profile.billing.intro")}</p>
        <BillingForm
          action={actions.updateBilling}
          billing={screen.billing}
          signInHref={signInHref}
        />
      </Card>
      <Card title={t("profile.email.title")} className="mb-4">
        {screen.open ? (
          <EmailChange
            currentEmail={screen.email}
            startAction={actions.startEmail}
            confirmAction={actions.confirmEmail}
            signInHref={signInHref}
          />
        ) : (
          notOpen
        )}
      </Card>
      <Card title={t("profile.phone.title")} className="mb-4">
        {screen.open ? (
          <PhoneChange
            phoneMasked={screen.phoneMasked}
            phoneVerified={screen.phoneVerified}
            startAction={actions.startPhone}
            confirmAction={actions.confirmPhone}
            signInHref={signInHref}
          />
        ) : (
          notOpen
        )}
      </Card>
      <Button variant="tertiary" href={securityHref} icon="fas fa-lock">
        {t("profile.toSecurity")}
      </Button>
    </>
  );
}
