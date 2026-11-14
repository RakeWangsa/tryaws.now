import { localePath } from "@tc/ui/runtime";
import { hasLocale } from "next-intl";
import { notFound, redirect } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

/**
 * /kyc. WPU-X11 (owner decision 2026-11-14): customers no longer do an identity check; buying needs a
 * verified e-mail, a verified mobile number and an authenticator app. The page leads to the dashboard,
 * whose checklist shows those three steps, and asks for no document. The KYC code, tables and the admin
 * screens are kept (no data is deleted); the KycContent screens stay for the record.
 */
export default async function KycPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // R9 step 1, as on every page of the panel: without a session this sends the visitor to sign in.
  await startPanelPage("/kyc");
  redirect(localePath(locale, "/dashboard"));
}
