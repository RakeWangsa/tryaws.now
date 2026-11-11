import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { Card } from "../components/Card.tsx";
import { Field, FormBlock } from "../components/Field.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { localeHrefs, localePath, type Locale } from "../runtime/index.ts";
import { AdminShell } from "../shells/AdminShell.tsx";
import { AppShell } from "../shells/AppShell.tsx";
import { AuthShell } from "../shells/AuthShell.tsx";
import { ADMIN_NAV, APP_NAV } from "../shells/nav.ts";
import { PublicShell } from "../shells/PublicShell.tsx";
import type { AdminNavId, AppNavId, ProductFamily } from "../shells/types.ts";
import { DEMO_BALANCE_MINOR } from "./data.ts";
import type { GalleryShell } from "./shells.ts";

const ALL_FAMILIES: readonly ProductFamily[] = [
  "cloudServers",
  "databases",
  "objectStorage",
  "loadBalancers",
  "containers",
  "cdn",
  "domains",
];
const ENABLED_FAMILIES = ALL_FAMILIES.filter((family) => family !== "containers");
const SOON_FAMILIES: readonly ProductFamily[] = ["containers"];

/** The entry named by `page`, or `fallback` when `page` is missing or not an id of the navigation. */
function pick<Id extends string>(
  entries: readonly { id: Id }[],
  page: string | undefined,
  fallback: Id,
): Id {
  const found = entries.find((entry) => entry.id === page);
  return found === undefined ? fallback : found.id;
}

function SampleContent(): ReactElement {
  const t = useTranslations("Gallery.demo");
  return (
    <div data-gallery="ShellContent">
      <Card title={t("shellContentTitle")} titleAs="h2">
        <p className="seccolor mb-0">{t("shellContentBody")}</p>
      </Card>
    </div>
  );
}

function PublicDemo({ locale }: { locale: Locale }): ReactElement {
  const t = useTranslations("Gallery.demo");
  return (
    <PublicShell
      locale={locale}
      localeHrefs={localeHrefs("/dev/ui/public")}
      signedIn={false}
      openFamilies={ALL_FAMILIES}
      domainsOpen
      announcement={t("announcement")}
      supportPhone={null}
    >
      <div className="container pt-150">
        <SampleContent />
      </div>
    </PublicShell>
  );
}

function AuthDemo({ locale }: { locale: Locale }): ReactElement {
  const t = useTranslations("Gallery.demo");
  return (
    <AuthShell locale={locale} localeHrefs={localeHrefs("/dev/ui/auth")}>
      <Tabs
        label={t("tabs.label")}
        tabs={[
          {
            id: "one",
            title: t("tabs.one"),
            content: (
              <FormBlock>
                <Field name="demo-email" type="email" label={t("field.email")} />
                <Field
                  name="demo-password"
                  type="password"
                  label={t("field.password")}
                  autoComplete="off"
                />
              </FormBlock>
            ),
          },
          {
            id: "two",
            title: t("tabs.two"),
            content: <p className="seccolor">{t("tabs.bodyTwo")}</p>,
          },
        ]}
      />
    </AuthShell>
  );
}

function AppDemo({ locale, page }: { locale: Locale; page: string | undefined }): ReactElement {
  const t = useTranslations();
  const currentId: AppNavId = pick(APP_NAV, page, "dashboard");
  return (
    <AppShell
      locale={locale}
      localeHrefs={localeHrefs("/dev/ui/app")}
      currentId={currentId}
      user={{ displayName: t("Gallery.demo.user") }}
      balanceMinor={DEMO_BALANCE_MINOR}
      enabledFamilies={ENABLED_FAMILIES}
      soonFamilies={SOON_FAMILIES}
      unreadCount={3}
      navHref={(id) => `${localePath(locale, "/dev/ui/app")}?page=${id}`}
    >
      <Card title={t("Gallery.demo.shellContentTitle")} titleAs="h2">
        <p className="seccolor mb-0">
          {t("Gallery.demo.selected", { name: t(`Shell.nav.${currentId}`) })}
        </p>
      </Card>
    </AppShell>
  );
}

function AdminDemo({ locale, page }: { locale: Locale; page: string | undefined }): ReactElement {
  const t = useTranslations();
  const currentId: AdminNavId = pick(ADMIN_NAV, page, "today");
  return (
    <AdminShell
      locale={locale}
      localeHrefs={localeHrefs("/dev/ui/admin")}
      currentId={currentId}
      admin={{ displayName: t("Gallery.demo.user"), role: "ops" }}
      visibleIds={null}
      navHref={(id) => `${localePath(locale, "/dev/ui/admin")}?page=${id}`}
    >
      <Card title={t("Gallery.demo.shellContentTitle")} titleAs="h2">
        <p className="seccolor mb-0">
          {t("Gallery.demo.selected", { name: t(`Shell.admin.nav.${currentId}`) })}
        </p>
      </Card>
    </AdminShell>
  );
}

/**
 * A shell with sample content (16.7, 16.12). `page` picks the highlighted entry of the panel
 * shells; anything that is not an id of the navigation falls back to the first entry (R16).
 */
export function ShellDemo({
  shell,
  locale,
  page,
}: {
  shell: GalleryShell;
  locale: Locale;
  page?: string;
}): ReactElement {
  switch (shell) {
    case "public":
      return <PublicDemo locale={locale} />;
    case "auth":
      return <AuthDemo locale={locale} />;
    case "app":
      return <AppDemo locale={locale} page={page} />;
    case "admin":
      return <AdminDemo locale={locale} page={page} />;
  }
}
