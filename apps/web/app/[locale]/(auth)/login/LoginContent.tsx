import { useTranslations } from "next-intl";
import type { Locale } from "@tc/ui/runtime";
import { safeNext } from "../../../../server/next-path.ts";
import { AuthAlert } from "../_components/AuthAlert.tsx";
import { AuthBody, AuthCard } from "../_components/AuthCard.tsx";
import { AuthUnavailableCard } from "../_components/AuthPageFrame.tsx";
import { LoginForm } from "./form.tsx";

/** /login (16.9): the "Already registered?" tab of login.html. */
export function LoginContent({
  locale,
  next,
  banner,
  available,
}: {
  locale: Locale;
  /** The raw `next` of the query; it is checked here again before it reaches the form (U12). */
  next: unknown;
  banner: "verified" | "reset" | null;
  available: boolean;
}) {
  const t = useTranslations("Auth");
  if (!available) return <AuthUnavailableCard locale={locale} title={t("meta.login")} />;
  return (
    <AuthCard
      title={t("card.title")}
      intro={t("card.intro")}
      tabs={{ active: "login", locale, next }}
    >
      <AuthBody heading={t("login.heading")}>
        {banner !== null ? (
          <AuthAlert kind="success">
            {t(banner === "verified" ? "login.verified" : "login.reset")}
          </AuthAlert>
        ) : null}
        <LoginForm locale={locale} next={safeNext(next) ?? ""} />
      </AuthBody>
    </AuthCard>
  );
}
