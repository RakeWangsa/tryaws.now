import { useTranslations } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { LocaleSwitch } from "../components/LocaleSwitch.tsx";
import { localePath, type Locale } from "../runtime/index.ts";
import { AwsLines } from "./parts/AwsLines.tsx";
import { Logo } from "./parts/Logo.tsx";

export interface AuthShellProps {
  locale: Locale;
  localeHrefs: Record<Locale, string>;
  children: ReactNode;
}

/**
 * The sign-in frame (16.7): one full-height card on the page of the mockup (login.html). The two
 * tabs inside the card belong to the page.
 */
export function AuthShell({ locale, localeHrefs, children }: AuthShellProps): ReactElement {
  const t = useTranslations("Shell");
  const home = localePath(locale, "/");
  return (
    <div className="fullrock config sec-bg3 motpath bg-colorstyle">
      <section className="fullrock-content">
        <div className="container">
          <a href={home} aria-label={t("homeLabel")}>
            <Logo />
          </a>
          <div className="tc-auth-lang">
            <LocaleSwitch
              current={locale}
              items={[
                { locale: "bn", href: localeHrefs.bn },
                { locale: "en", href: localeHrefs.en },
              ]}
            />
          </div>
          <main id="main">
            <div className="sec-main sec-bg1 tabs bg-seccolorstyle noshadow">{children}</div>
          </main>
          <p>
            <a className="golink" href={home}>
              {t("auth.backHome")}
            </a>
          </p>
          <div className="tc-footer-aws">
            <AwsLines variant="short" />
          </div>
        </div>
      </section>
    </div>
  );
}
