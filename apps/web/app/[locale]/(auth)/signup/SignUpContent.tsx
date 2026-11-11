import { useTranslations } from "next-intl";
import type { Locale } from "@tc/ui/runtime";
import { safeNext } from "../../../../server/next-path.ts";
import { AuthBody, AuthCard } from "../_components/AuthCard.tsx";
import { AuthUnavailableCard } from "../_components/AuthPageFrame.tsx";
import { SignUpForm } from "./form.tsx";

/** /signup (16.9): the "Create a New Account" tab of login.html. */
export function SignUpContent({
  locale,
  next,
  available,
}: {
  locale: Locale;
  next: unknown;
  available: boolean;
}) {
  const t = useTranslations("Auth");
  if (!available) return <AuthUnavailableCard locale={locale} title={t("meta.signup")} />;
  return (
    <AuthCard
      title={t("card.title")}
      intro={t("card.intro")}
      tabs={{ active: "signup", locale, next }}
    >
      <AuthBody heading={t("signup.heading")}>
        <SignUpForm locale={locale} next={safeNext(next) ?? ""} />
      </AuthBody>
    </AuthCard>
  );
}
