import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AuthShell, Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { AuthCard } from "./AuthCard.tsx";

/** The frame of one sign-in screen: the card of login.html (English only, WPU-X19). */
export function AuthPageFrame({
  locale,
  children,
}: {
  locale: Locale;
  /** The screen's own path. WPU-X19: no language switch on the sign-in screens, so it is not used now. */
  path: string;
  children: ReactNode;
}) {
  return <AuthShell locale={locale}>{children}</AuthShell>;
}

/**
 * The state when the identity provider or the limiter key is not configured (R16, U11): a sentence
 * and one way out, no form.
 */
export function AuthNotAvailable({ locale }: { locale: Locale }) {
  const t = useTranslations("Auth.state");
  return (
    <div className="mt-4">
      <EmptyState
        title={t("notAvailableTitle")}
        description={t("notAvailableText")}
        action={
          <Button variant="primary" href={localePath(locale, "/")}>
            {t("home")}
          </Button>
        }
      />
    </div>
  );
}

/** The card for a not-available screen. */
export function AuthUnavailableCard({ locale, title }: { locale: Locale; title: string }) {
  return (
    <AuthCard title={title}>
      <AuthNotAvailable locale={locale} />
    </AuthCard>
  );
}
