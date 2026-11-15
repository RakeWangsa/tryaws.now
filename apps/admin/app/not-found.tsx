import { getLocale } from "next-intl/server";
import { useTranslations } from "next-intl";
import { AdminShell, Button, EmptyState } from "@tc/ui";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";

const PlaceholderAdmin = { displayName: "", role: "support" } as const;

function Missing({ locale }: { locale: Locale }) {
  const t = useTranslations("Shell");
  return (
    <AdminShell locale={locale} currentId="today" admin={PlaceholderAdmin} visibleIds={["today"]}>
      <EmptyState
        title={t("notFound.title")}
        description={t("notFound.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/")}>
            {t("auth.backHome")}
          </Button>
        }
      />
    </AdminShell>
  );
}

export default async function NotFound() {
  const requested = await getLocale();
  return <Missing locale={isLocale(requested) ? requested : DEFAULT_LOCALE} />;
}
