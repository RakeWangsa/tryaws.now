import { Button } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { breadcrumbLd } from "../../../../server/public/seo.ts";
import { JsonLds } from "../_components/JsonLd.tsx";
import type { Tr } from "../_components/offers.tsx";

// `/support` (contact.html, without the map and the newsletter box): how to reach MeghVPS. The
// ticket form of a signed-in customer is a separate task (WP9); this page links to it through the
// sign-in. The phone number and the support address are not decided yet (JOURNEY.md, Needs
// decision), so the page says they are coming instead of showing a made-up value.

export function SupportContent({
  locale,
  origin,
  nonce,
  phone,
  email,
}: {
  locale: Locale;
  origin: string | null;
  nonce: string | undefined;
  /** null until the decision of the owner. */
  phone: string | null;
  email: string | null;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  const tShell = useTranslations("Shell");
  const p = (path: string): string => localePath(locale, path);
  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          breadcrumbLd(o, locale, [
            { name: t("crumb.home"), path: "/" },
            { name: t("support.heading"), path: "/support" },
          ]),
        ]}
      />
      <div className="top-header">
        <div className="container">
          <div className="row">
            <div className="col-lg-12">
              <div className="wrapper">
                <h1 className="heading mb-0">{t("support.heading")}</h1>
                <p className="seccolor">{t("support.lead")}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <section id="ticket" className="exapath pb-80 noimage bg-seccolorstyle toppadding">
        <div className="container">
          <div className="sec-main sec-up mb-0 sec-bg1 bg-seccolorstyle nomargin noshadow">
            <div className="row">
              <div className="col-md-6">
                <h2 className="h4 mergecolor">{t("support.phoneTitle")}</h2>
                <p className="seccolor">{phone ?? t("support.phonePending")}</p>
                <h2 className="h4 mergecolor">{t("support.emailTitle")}</h2>
                <p className="seccolor">{email ?? t("support.emailPending")}</p>
                <p className="seccolor">
                  <strong>{tShell("footer.companyName")}</strong>
                  <br />
                  {tShell("footer.address")}
                </p>
              </div>
              <div className="col-md-6">
                <h2 className="h4 mergecolor">{t("support.signedInTitle")}</h2>
                <p className="seccolor">{t("support.signedInText")}</p>
                <Button variant="primary" href={p("/login")}>
                  {t("support.signedInCta")}
                </Button>
                <h2 className="h4 mergecolor mt-4">{t("support.faqTitle")}</h2>
                <p className="seccolor">{t("support.faqText")}</p>
                <Button variant="tertiary" href={p("/help")}>
                  {t("support.faqCta")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
