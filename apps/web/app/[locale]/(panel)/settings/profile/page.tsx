import { localePath } from "@tc/ui/runtime";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { getRuntime } from "../../../../../server/runtime.ts";
import { loadProfileScreen } from "../../../../../server/settings-view.ts";
import { loginRedirect } from "../../../../../server/panel.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import {
  confirmEmailChangeAction,
  confirmPhoneChangeAction,
  startEmailChangeAction,
  startPhoneChangeAction,
  updateBillingAction,
  updateProfileAction,
} from "./actions.ts";
import { ProfileContent } from "./ProfileContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Settings.profile.meta.title"), robots: { index: false, follow: false } };
}

/** /settings/profile (16.10): name, language, e-mail and phone. */
export default async function ProfilePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/settings/profile");
  const { account } = await getRuntime();
  const screen = await loadProfileScreen(panel.session, account !== null);
  return (
    <PanelFrame locale={locale} path="/settings/profile" currentId="settings" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Settings.profile.heading")}</h1>
      <ProfileContent
        screen={screen}
        actions={{
          updateProfile: updateProfileAction,
          updateBilling: updateBillingAction,
          startEmail: startEmailChangeAction,
          confirmEmail: confirmEmailChangeAction,
          startPhone: startPhoneChangeAction,
          confirmPhone: confirmPhoneChangeAction,
        }}
        signInHref={loginRedirect(locale, "/settings/profile")}
        securityHref={localePath(locale, "/settings/security")}
      />
    </PanelFrame>
  );
}
