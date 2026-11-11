import { localePath } from "@tc/ui/runtime";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loginRedirect } from "../../../../../server/panel.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { getRuntime } from "../../../../../server/runtime.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { changePasswordAction } from "./actions.ts";
import { SecurityContent } from "./SecurityContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Settings.security.meta.title"), robots: { index: false, follow: false } };
}

/** /settings/security (16.10): the password. */
export default async function SecurityPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/settings/security");
  const { account } = await getRuntime();
  return (
    <PanelFrame locale={locale} path="/settings/security" currentId="settings" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Settings.security.heading")}</h1>
      <SecurityContent
        open={account !== null}
        changePassword={changePasswordAction}
        signInHref={loginRedirect(locale, "/settings/security")}
        profileHref={localePath(locale, "/settings/profile")}
      />
    </PanelFrame>
  );
}
