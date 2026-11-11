import { Button, Card, EmptyState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import { PasswordForm } from "./SecurityForms.tsx";

// The content of /settings/security: the password change behind a fresh sign-in (6.1). Synchronous,
// so it renders in a test without a request. TOTP setup and "sign out of other sessions" of 16.10
// are not part of task WP2-T5 and are not shown.

export function SecurityContent({
  open,
  changePassword,
  signInHref,
  profileHref,
}: {
  open: boolean;
  changePassword: (previous: FormState, form: FormData) => Promise<FormState>;
  signInHref: string;
  profileHref: string;
}) {
  const t = useTranslations("Settings");
  return (
    <>
      <p className="seccolor mb-2">{t("security.intro")}</p>
      <p className="seccolor mb-4">
        <i className="fas fa-shield-alt me-2" aria-hidden="true" />
        {t("fresh.note")}
      </p>
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
