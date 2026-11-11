import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadAuthPage, readPending } from "../../../../server/auth-page.ts";
import { AuthPageFrame } from "../_components/AuthPageFrame.tsx";
import { ResetContent } from "./ResetContent.tsx";

// Reads the session, the runtime and the pending cookie: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Auth.meta.reset"), robots: { index: false, follow: false } };
}

/** /reset-password: the address is prefilled from the pending cookie, which is only a prefill. */
export default async function ResetPasswordPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const page = await loadAuthPage(locale, undefined, { guest: true });
  const pending = await readPending();
  const email = pending !== null && pending.p === "reset" ? pending.e : "";
  return (
    <AuthPageFrame locale={locale} path="/reset-password">
      <ResetContent locale={locale} email={email} available={page.available} />
    </AuthPageFrame>
  );
}
