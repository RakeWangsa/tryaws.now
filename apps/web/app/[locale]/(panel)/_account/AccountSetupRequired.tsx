import { ACCOUNT_SETUP_STEPS, type AccountSetupStep } from "@tc/core";
import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { SETUP_STEP_PATHS } from "../../../../server/account-setup.ts";

// WPU-X11 (owner decision 2026-11-14): what every buy screen shows while the account setup is not done.
// The three steps in order, each marked done or to do by an icon AND a word (U11: not by color alone),
// and one primary button to the first missing step. Nothing asks for documents: KYC is not a condition.

export function AccountSetupRequired({
  locale,
  missing,
}: {
  locale: Locale;
  missing: readonly AccountSetupStep[];
}) {
  const t = useTranslations("AccountSetup");
  const first = missing[0] ?? "totp";
  return (
    <EmptyState
      title={t("title")}
      description={t("body")}
      action={
        <>
          <ol className="list-unstyled d-inline-block text-start mb-4">
            {ACCOUNT_SETUP_STEPS.map((step, index) => {
              const done = !missing.includes(step);
              return (
                <li key={step} className="mb-2">
                  <i
                    className={done ? "fas fa-check-circle me-2" : "far fa-circle me-2"}
                    aria-hidden="true"
                  />
                  {done ? (
                    <span>{t(`steps.${step}`, { n: index + 1 })}</span>
                  ) : (
                    <a href={localePath(locale, SETUP_STEP_PATHS[step])}>
                      {t(`steps.${step}`, { n: index + 1 })}
                    </a>
                  )}
                  {" · "}
                  <span className="seccolor">{done ? t("done") : t("todo")}</span>
                </li>
              );
            })}
          </ol>
          <div>
            <Button variant="primary" href={localePath(locale, SETUP_STEP_PATHS[first])}>
              {t(`action.${first}`)}
            </Button>
          </div>
        </>
      }
    />
  );
}
