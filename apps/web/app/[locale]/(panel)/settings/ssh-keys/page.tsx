import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadSshKeys } from "../../../../../server/servers-view.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { addSshKeyAction, removeSshKeyAction } from "./actions.ts";
import { SshKeysContent } from "./SshKeysContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("SshKeys.meta.title"), robots: { index: false, follow: false } };
}

/** /settings/ssh-keys (16.10): the customer's public keys. */
export default async function SshKeysPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/settings/ssh-keys");
  const screen = await loadSshKeys(panel.session);
  return (
    <PanelFrame locale={locale} path="/settings/ssh-keys" currentId="settings" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("SshKeys.heading")}</h1>
      <SshKeysContent
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        addAction={addSshKeyAction}
        removeAction={removeSshKeyAction}
      />
    </PanelFrame>
  );
}
