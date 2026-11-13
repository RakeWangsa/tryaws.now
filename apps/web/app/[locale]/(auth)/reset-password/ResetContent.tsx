import { useTranslations } from "next-intl";
import type { Locale } from "@tc/ui/runtime";
import { AuthCard } from "../_components/AuthCard.tsx";
import { AuthUnavailableCard } from "../_components/AuthPageFrame.tsx";
import { ResetForm } from "./form.tsx";

/** /reset-password (16.9): the body of password-reset-change-prompt.tpl inside the card, with the code field. */
export function ResetContent({
  locale,
  email,
  available,
}: {
  locale: Locale;
  email: string;
  available: boolean;
}) {
  const t = useTranslations("Auth");
  if (!available) return <AuthUnavailableCard locale={locale} title={t("meta.reset")} />;
  return (
    <AuthCard title={t("reset.heading")}>
      <p className="mergecolor">{t("reset.intro")}</p>
      <ResetForm locale={locale} email={email} />
    </AuthCard>
  );
}
