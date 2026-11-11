import { useTranslations } from "next-intl";
import type { Locale } from "@tc/ui/runtime";
import { safeNext } from "../../../../server/next-path.ts";
import type { PhoneStep } from "../../../../server/phone-step.ts";
import { AuthCard } from "../_components/AuthCard.tsx";
import { AuthUnavailableCard } from "../_components/AuthPageFrame.tsx";
import { EmailVerifyForms } from "./email-form.tsx";
import { PhoneVerifyForms } from "./phone-form.tsx";

export type VerifyStep =
  | { kind: "email"; email: string; resendAt: number | null }
  | { kind: "phone"; step: Exclude<PhoneStep, { kind: "verified" }> };

/**
 * /verify (16.9): two steps chosen by the server, not by the URL. Without a session the email step
 * (the card of login.html with the body of user-verify-email.tpl); with a session the phone step.
 */
export function VerifyContent({
  locale,
  next,
  available,
  step,
}: {
  locale: Locale;
  next: unknown;
  available: boolean;
  step: VerifyStep;
}) {
  const t = useTranslations("Auth");
  const safe = safeNext(next) ?? "";

  if (step.kind === "email") {
    if (!available) return <AuthUnavailableCard locale={locale} title={t("meta.verify")} />;
    return (
      <AuthCard title={t("verify.email.heading")} intro={t("verify.email.intro")}>
        <div className="text-center mb-4">
          <i className="far fa-clock fa-2x text-warning" aria-hidden="true" />
        </div>
        <EmailVerifyForms locale={locale} email={step.email} next={safe} resendAt={step.resendAt} />
      </AuthCard>
    );
  }

  if (step.step.kind === "unavailable") {
    return <AuthUnavailableCard locale={locale} title={t("verify.phone.notAvailable")} />;
  }
  return (
    <AuthCard title={t("verify.phone.heading")} intro={t("verify.phone.intro")}>
      <PhoneVerifyForms
        locale={locale}
        next={safe}
        phone={step.step.phone}
        challenge={step.step.challenge}
        idempotencyKey={step.step.idempotencyKey}
      />
    </AuthCard>
  );
}
