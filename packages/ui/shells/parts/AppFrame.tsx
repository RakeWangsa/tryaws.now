import { useTranslations } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { LocaleSwitch } from "../../components/LocaleSwitch.tsx";
import { LOCALES, type Locale } from "../../runtime/index.ts";
import { AwsLines } from "./AwsLines.tsx";
import { Logo } from "./Logo.tsx";
import { NavDrawer } from "./NavDrawer.tsx";

export interface AppFrameProps {
  locale: Locale;
  /** WPU-X19: the language switch is shown only when the hrefs are given (the home page). */
  localeHrefs?: Record<Locale, string> | undefined;
  homeHref: string;
  /** The accessible name of the navigation. */
  navLabel: string;
  /** The rows of the navigation; shown in the left column and, under 992 px, in the drawer. */
  nav: ReactNode;
  /** Next to the logo (the OPS label of the admin). */
  brandExtra?: ReactNode;
  /** Between the language switch and the account menu (wallet, bell). */
  topExtras?: ReactNode;
  account: ReactNode;
  children: ReactNode;
}

/** The frame both panel shells share (16.7): top bar, left navigation, main column, slim footer. */
export function AppFrame({
  locale,
  localeHrefs,
  homeHref,
  navLabel,
  nav,
  brandExtra,
  topExtras,
  account,
  children,
}: AppFrameProps): ReactElement {
  const t = useTranslations("Shell");
  const navigation = (
    <nav aria-label={navLabel}>
      <div className="menu categories clear">{nav}</div>
    </nav>
  );
  return (
    <>
      <a className="tc-skip-link" href="#main">
        {t("skip")}
      </a>
      <div className="tc-shell-fill bg-colorstyle">
        <header className="menu-wrap tc-app-bar">
          <div className="nav-menu">
            <div className="container-fluid">
              <div className="row align-items-center">
                <div className="col-auto d-flex align-items-center">
                  <NavDrawer openLabel={t("app.openNav")} closeLabel={t("close")} title={navLabel}>
                    {navigation}
                  </NavDrawer>
                  <a href={homeHref} aria-label={t("homeLabel")}>
                    <Logo />
                  </a>
                  {brandExtra}
                </div>
                <div className="col d-flex flex-wrap align-items-center justify-content-end gap-2 gap-md-3">
                  {localeHrefs === undefined ? null : (
                    <LocaleSwitch
                      current={locale}
                      items={LOCALES.map((item) => ({ locale: item, href: localeHrefs[item] }))}
                    />
                  )}
                  {topExtras}
                  {account}
                </div>
              </div>
            </div>
          </div>
        </header>
        <section className="blog motpath pb-80 bg-colorstyle">
          <div className="container-fluid pt-4">
            <div className="row">
              <div className="col-lg-3 d-none d-lg-block">
                <aside
                  id="sidebar"
                  className="sidebar sec-bg1 bg-seccolorstyle noshadow tc-app-nav"
                >
                  {navigation}
                </aside>
              </div>
              <div className="col-lg-9">
                <div id="sidebar_content" className="wrap-blog">
                  <main id="main">{children}</main>
                </div>
              </div>
            </div>
          </div>
        </section>
        <footer className="tc-app-footer bg-colorstyle mergecolor">
          <div className="container-fluid">
            <AwsLines variant="short" />
          </div>
        </footer>
      </div>
    </>
  );
}
