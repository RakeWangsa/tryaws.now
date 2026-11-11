import { useTranslations } from "next-intl";
import { AuthShell, Button, ErrorPage } from "@tc/ui";
import { localeHrefs, localePath, type Locale } from "@tc/ui/runtime";

// The page for every refusal that is not "no session": it names no check (R14, 16.13).
export function NoAccess({ locale, path }: { locale: Locale; path: string }) {
  const t = useTranslations("Admin.noAccess");
  return (
    <AuthShell locale={locale} localeHrefs={localeHrefs(path)}>
      <ErrorPage
        title={t("title")}
        message={t("body")}
        home={
          <Button variant="tertiary" href={localePath(locale, "/login")}>
            {t("login")}
          </Button>
        }
      />
    </AuthShell>
  );
}
