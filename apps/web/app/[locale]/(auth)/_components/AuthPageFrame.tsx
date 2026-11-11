import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AuthShell, Button, EmptyState } from "@tc/ui";
import { localeHrefs, localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { AuthCard } from "./AuthCard.tsx";

/** The frame of one sign-in screen: the card of login.html with the language switch of its own path. */
export function AuthPageFrame({
  locale,
  path,
  children,
}: {
  locale: Locale;
  /** The screen's own path without locale, for the language switch. */
  path: string;
  children: ReactNode;
}) {
  return (
    <AuthShell locale={locale} localeHrefs={localeHrefs(path)}>
      {children}
    </AuthShell>
  );
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
