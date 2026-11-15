import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@tc/ui";
import { isLocale } from "@tc/ui/runtime";
import { loginClientMessages } from "./client-messages.ts";
import { LoginForm } from "./LoginForm.tsx";

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Admin.login" });
  return { title: t("title") };
}

// 16.12 /login: sign-in with TOTP, always, for every role.
export default async function Page({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <AuthShell locale={locale}>
      <NextIntlClientProvider locale={locale} messages={loginClientMessages(locale)}>
        <LoginForm locale={locale} />
      </NextIntlClientProvider>
    </AuthShell>
  );
}
