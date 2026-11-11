import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadAuthPage } from "../../../../server/auth-page.ts";
import { AuthPageFrame } from "../_components/AuthPageFrame.tsx";
import { ForgotContent } from "./ForgotContent.tsx";

// Reads the session and the runtime: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Auth.meta.forgot"), robots: { index: false, follow: false } };
}

/** /forgot-password: a signed-in customer goes to the panel. */
export default async function ForgotPasswordPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const page = await loadAuthPage(locale, undefined, { guest: true });
  return (
    <AuthPageFrame locale={locale} path="/forgot-password">
      <ForgotContent locale={locale} available={page.available} />
    </AuthPageFrame>
  );
}
