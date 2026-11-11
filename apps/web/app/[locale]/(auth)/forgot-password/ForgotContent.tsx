import { useTranslations } from "next-intl";
import type { Locale } from "@tc/ui/runtime";
import { AuthCard } from "../_components/AuthCard.tsx";
import { AuthUnavailableCard } from "../_components/AuthPageFrame.tsx";
import { ForgotForm } from "./form.tsx";

/** /forgot-password (16.9): the body of password-reset-email-prompt.tpl inside the card. */
export function ForgotContent({ locale, available }: { locale: Locale; available: boolean }) {
  const t = useTranslations("Auth");
  if (!available) return <AuthUnavailableCard locale={locale} title={t("meta.forgot")} />;
  return (
    <AuthCard title={t("forgot.heading")}>
      <div className="text-center">
        <p className="section-subheading mergecolor">{t("forgot.intro")}</p>
      </div>
      <div className="mt-50">
        <ForgotForm locale={locale} />
      </div>
    </AuthCard>
  );
}
