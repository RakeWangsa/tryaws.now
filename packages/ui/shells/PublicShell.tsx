import { useTranslations } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { LocaleSwitch } from "../components/LocaleSwitch.tsx";
import { localePath, type Locale } from "../runtime/index.ts";
import { PUBLIC_FAMILY_HREF } from "./nav.ts";
import { AwsLines } from "./parts/AwsLines.tsx";
import { CreditLine } from "./parts/CreditLine.tsx";
import { Logo } from "./parts/Logo.tsx";
import { MobileMenu } from "./parts/MobileMenu.tsx";
import type { ProductFamily } from "./types.ts";

export interface PublicShellProps {
  locale: Locale;
  /** WPU-X19: the language switch is shown only when the hrefs are given (the home page). */
  localeHrefs?: Record<Locale, string> | undefined;
  signedIn: boolean;
  openFamilies: readonly ProductFamily[];
  domainsOpen: boolean;
  announcement: string | null;
  supportPhone: string | null;
  paymentBanner?: ReactNode;
  children: ReactNode;
}

interface ProductLink {
  family: ProductFamily;
  href: string;
}

/** Open families that have a public page, domains excluded (they have their own item). */
function productLinks(locale: Locale, openFamilies: readonly ProductFamily[]): ProductLink[] {
  const links: ProductLink[] = [];
  for (const family of openFamilies) {
    const path = PUBLIC_FAMILY_HREF[family];
    if (family !== "domains" && path !== undefined) {
      links.push({ family, href: localePath(locale, path) });
    }
  }
  return links;
}

/** `tel:` target of a phone number: a leading `+` and digits only. */
function telHref(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits === "") return null;
  return `tel:${phone.trim().startsWith("+") ? "+" : ""}${digits}`;
}

/** The public pages' frame (16.7): top line, menu, footer with the AWS statement. */
export function PublicShell({
  locale,
  localeHrefs,
  signedIn,
  openFamilies,
  domainsOpen,
  announcement,
  supportPhone,
  paymentBanner,
  children,
}: PublicShellProps): ReactElement {
  const t = useTranslations("Shell");
  const p = (path: string): string => localePath(locale, path);
  const products = productLinks(locale, openFamilies);
  const phoneHref = supportPhone === null ? null : telHref(supportPhone);
  const hasTopLine = announcement !== null || phoneHref !== null;
  const accountHref = signedIn ? p("/dashboard") : p("/login");
  const accountLabel = signedIn ? t("public.console") : t("public.login");
  const switcher =
    localeHrefs === undefined ? null : (
      <div className="menu-item">
        <LocaleSwitch
          current={locale}
          items={[
            { locale: "bn", href: localeHrefs.bn },
            { locale: "en", href: localeHrefs.en },
          ]}
        />
      </div>
    );
  const accountButton = (
    <a className="btn btn-default-yellow-fill question" href={accountHref}>
      <span>{accountLabel}</span> <i className="fas fa-lock ps-1" aria-hidden="true"></i>
    </a>
  );
  const homeHref = p("/");

  return (
    <>
      <a className="tc-skip-link" href="#main">
        {t("skip")}
      </a>
      <div className="tc-shell-fill bg-colorstyle">
        <header>
          {hasTopLine ? (
            <div className="sec-bg3 infonews">
              <div className="container-fluid">
                <div className="row">
                  <div className="col-6 col-md-7 news">
                    {announcement !== null ? <span>{announcement}</span> : null}
                  </div>
                  <div className="col-6 col-md-5 link">
                    <div className="infonews-nav float-end">
                      {phoneHref !== null ? (
                        <a
                          className="iconews tabphone"
                          href={phoneHref}
                          title={t("public.supportPhone")}
                        >
                          {supportPhone}
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <div className="menu-wrap">
            <div className="nav-menu">
              <div className="container">
                <div className="row align-items-center">
                  <div className="col-2 col-md-2">
                    <a href={homeHref} aria-label={t("homeLabel")}>
                      <Logo />
                    </a>
                  </div>
                  <nav id="menu" className="col-10 col-md-10" aria-label={t("public.menuLabel")}>
                    <div className="navigation float-end">
                      <div className="main-menu nav navbar-nav navbar-right">
                        {products.length > 0 ? (
                          <div className="menu-item menu-item-has-children">
                            <a href="#menu" aria-haspopup="true">
                              {t("public.products")}
                            </a>
                            <ul className="sub-menu dropdown bg-colorstyle">
                              {products.map((product) => (
                                <li key={product.family} className="menu-item">
                                  <a className="mergecolor" href={product.href}>
                                    {t(`nav.${product.family}`)}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <div className="menu-item">
                          <a href={p("/pricing")}>{t("public.pricing")}</a>
                        </div>
                        {domainsOpen ? (
                          <div className="menu-item">
                            <a href={p("/products/domains")}>{t("public.domains")}</a>
                          </div>
                        ) : null}
                        <div className="menu-item">
                          <a href={p("/help")}>{t("public.help")}</a>
                        </div>
                        {switcher}
                        <div className="menu-item">{accountButton}</div>
                      </div>
                    </div>
                  </nav>
                </div>
              </div>
            </div>
          </div>
          <MobileMenu
            label={t("menu")}
            brand={
              <a href={homeHref} aria-label={t("homeLabel")}>
                <Logo />
              </a>
            }
          >
            {products.map((product) => (
              <div key={product.family} className="menu-item">
                <a className="mergecolor" href={product.href}>
                  {t(`nav.${product.family}`)}
                </a>
              </div>
            ))}
            <div className="menu-item">
              <a className="mergecolor" href={p("/pricing")}>
                {t("public.pricing")}
              </a>
            </div>
            {domainsOpen ? (
              <div className="menu-item">
                <a className="mergecolor" href={p("/products/domains")}>
                  {t("public.domains")}
                </a>
              </div>
            ) : null}
            <div className="menu-item">
              <a className="mergecolor" href={p("/help")}>
                {t("public.help")}
              </a>
            </div>
            {switcher}
            <div className="menu-item">{accountButton}</div>
          </MobileMenu>
        </header>
        <main id="main" className="bg-colorstyle">
          {children}
        </main>
        <footer className="footer">
          <div className="container">
            <div className="footer-top">
              <div className="row">
                <div className="col-sm-6 col-md-3">
                  <div className="heading">{t("footer.products")}</div>
                  <ul className="footer-menu">
                    {products.map((product) => (
                      <li key={product.family} className="menu-item">
                        <a href={product.href}>{t(`nav.${product.family}`)}</a>
                      </li>
                    ))}
                    {domainsOpen ? (
                      <li className="menu-item">
                        <a href={p("/products/domains")}>{t("public.domains")}</a>
                      </li>
                    ) : null}
                  </ul>
                </div>
                <div className="col-sm-6 col-md-3">
                  <div className="heading">{t("footer.company")}</div>
                  <ul className="footer-menu">
                    <li className="menu-item">
                      <a href={p("/pricing")}>{t("footer.pricing")}</a>
                    </li>
                  </ul>
                </div>
                <div className="col-sm-6 col-md-3">
                  <div className="heading">{t("footer.support")}</div>
                  <ul className="footer-menu">
                    <li className="menu-item">
                      <a href={p("/help")}>{t("footer.help")}</a>
                    </li>
                    <li className="menu-item">
                      <a href={p("/support")}>{t("footer.contact")}</a>
                    </li>
                  </ul>
                </div>
                <div className="col-sm-6 col-md-3">
                  <div className="heading">{t("footer.legal")}</div>
                  <ul className="footer-menu">
                    <li className="menu-item">
                      <a href={p("/legal/terms")}>{t("footer.terms")}</a>
                    </li>
                    <li className="menu-item">
                      <a href={p("/legal/privacy")}>{t("footer.privacy")}</a>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
          <div className="footer-bottom">
            <div className="container">
              <div className="row">
                <div className="col-lg-6">
                  <p className="contact">
                    <strong>{t("footer.companyName")}</strong>
                  </p>
                  <p className="contact">{t("footer.address")}</p>
                  <p className="contact">
                    {t("footer.bin")}
                    <br />
                    {t("footer.tradeLicense")}
                  </p>
                </div>
                <div className="col-lg-6">{paymentBanner}</div>
              </div>
              <div className="row">
                <div className="col-12 contact tc-footer-aws">
                  <AwsLines variant="short" />
                  <CreditLine />
                </div>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
