import { Button, Card, EmptyState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { TotpFormState } from "./actions.ts";
import { PasswordForm } from "./SecurityForms.tsx";
import { TotpDisableForm, TotpSetupForms } from "./TotpForms.tsx";

// The content of /settings/security: the password change and (WPU-X11) the authenticator app, both
// behind a fresh sign-in (6.1). Synchronous, so it renders in a test without a request. "Sign out of
// other sessions" of 16.10 is not part of these tasks and is not shown.

type TotpAction = (previous: TotpFormState, form: FormData) => Promise<TotpFormState>;
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export interface TotpProps {
  /** null: the state could not be read or the authenticator is not configured: nothing is offered (R16). */
  enabled: boolean | null;
  start: TotpAction;
  confirm: TotpAction;
  disable: Action;
}

export function SecurityContent({
  open,
  changePassword,
  signInHref,
  profileHref,
  totp,
}: {
  open: boolean;
  changePassword: Action;
  signInHref: string;
  profileHref: string;
  totp: TotpProps;
}) {
  const t = useTranslations("Settings");
  return (
    <>
      <p className="seccolor mb-2">{t("security.intro")}</p>
      <p className="seccolor mb-4">
        <i className="fas fa-shield-alt me-2" aria-hidden="true" />
        {t("fresh.note")}
      </p>
      <Card title={t("security.totp.title")} className="mb-4">
        {totp.enabled === null ? (
          <EmptyState title={t("notOpen.title")} description={t("notOpen.body")} />
        ) : (
          <>
            <p className="seccolor">{t("security.totp.intro")}</p>
            <p className="mb-3">
              <i
                className={totp.enabled ? "fas fa-check-circle me-2" : "far fa-circle me-2"}
                aria-hidden="true"
              />
              <strong>
                {totp.enabled ? t("security.totp.statusOn") : t("security.totp.statusOff")}
              </strong>
            </p>
            {totp.enabled ? (
              <TotpDisableForm action={totp.disable} signInHref={signInHref} />
            ) : (
              <TotpSetupForms start={totp.start} confirm={totp.confirm} signInHref={signInHref} />
            )}
          </>
        )}
      </Card>
      <Card title={t("security.password.title")} className="mb-4">
        {open ? (
          <PasswordForm action={changePassword} signInHref={signInHref} />
        ) : (
          <EmptyState title={t("notOpen.title")} description={t("notOpen.body")} />
        )}
      </Card>
      <Button variant="tertiary" href={profileHref} icon="fas fa-user">
        {t("security.toProfile")}
      </Button>
    </>
  );
}
