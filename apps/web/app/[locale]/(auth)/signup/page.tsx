import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadAuthPage, queryText } from "../../../../server/auth-page.ts";
import { AuthPageFrame } from "../_components/AuthPageFrame.tsx";
import { SignUpContent } from "./SignUpContent.tsx";

// Reads the session and the runtime: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Auth.meta.signup"), robots: { index: false, follow: false } };
}

/** /signup: a signed-in customer goes to the panel. */
export default async function SignUpPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const next = queryText((await searchParams)["next"]);
  const page = await loadAuthPage(locale, next, { guest: true });
  return (
    <AuthPageFrame locale={locale} path="/signup">
      <SignUpContent locale={locale} next={next} available={page.available} />
    </AuthPageFrame>
  );
}
