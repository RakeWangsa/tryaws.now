import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { landingPath } from "../../../../server/auth/landing.ts";
import { loadAuthPage, queryText, readPending } from "../../../../server/auth-page.ts";
import { loadPhoneStep } from "../../../../server/phone-step.ts";
import { AuthPageFrame } from "../_components/AuthPageFrame.tsx";
import { VerifyContent } from "./VerifyContent.tsx";
import type { VerifyStep } from "./VerifyContent.tsx";

// Reads the session, the runtime, the pending cookie and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The resend timer of 16.9: one clock minute (packages/notify OTP.resendSeconds, for the email too).
const EMAIL_RESEND_SECONDS = 60;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Auth.meta.verify"), robots: { index: false, follow: false } };
}

/** /verify is open to both: without a session the email step, with one the phone step. */
export default async function VerifyPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const next = queryText((await searchParams)["next"]);
  const page = await loadAuthPage(locale, next, { guest: false });

  let step: VerifyStep;
  if (page.session !== null) {
    const phone = await loadPhoneStep(page.session, page.runtime.otp !== null);
    if (phone.kind === "verified") redirect(landingPath(locale, next));
    step = { kind: "phone", step: phone };
  } else {
    const pending = await readPending();
    const email = pending !== null && pending.p === "signup" ? pending.e : "";
    step = {
      kind: "email",
      email,
      resendAt: pending === null ? null : pending.t + EMAIL_RESEND_SECONDS,
    };
  }
  return (
    <AuthPageFrame locale={locale} path="/verify">
      <VerifyContent locale={locale} next={next} available={page.available} step={step} />
    </AuthPageFrame>
  );
}
