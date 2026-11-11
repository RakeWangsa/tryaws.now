import {
  KYC_CONTENT_TYPES,
  KYC_CUSTOMER_TYPES,
  KYC_MAX_FILES,
  KYC_MAX_FILE_BYTES,
  documentTypesFor,
} from "@tc/core";
import { localePath } from "@tc/ui/runtime";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { getRuntime } from "../../../../server/runtime.ts";
import { loadKyc } from "../../../../server/kyc-view.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import { startKycUploadAction, submitKycAction } from "./actions.ts";
import type { KycLimits } from "./KycForm.tsx";
import { KycContent } from "./KycContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Kyc.meta.title"), robots: { index: false, follow: false } };
}

// The limits come from the one place that owns them; the client form never imports @tc/core.
const LIMITS: KycLimits = {
  maxBytes: KYC_MAX_FILE_BYTES,
  contentTypes: KYC_CONTENT_TYPES,
  maxFiles: KYC_MAX_FILES,
  documents: Object.fromEntries(
    KYC_CUSTOMER_TYPES.map((type) => [type, documentTypesFor(type)]),
  ) as KycLimits["documents"],
};

/** /kyc (16.9): the identity check. */
export default async function KycPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/kyc");
  const { kyc } = await getRuntime();
  const screen = await loadKyc(panel.session, kyc !== null);
  return (
    <PanelFrame locale={locale} path="/kyc" currentId="dashboard" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Kyc.heading")}</h1>
      <KycContent
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        limits={LIMITS}
        startAction={startKycUploadAction}
        submitAction={submitKycAction}
        serversHref={localePath(locale, "/servers")}
      />
    </PanelFrame>
  );
}
