import { Button } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { breadcrumbLd } from "../../../../server/public/seo.ts";
import { PublicSupportForm } from "./PublicSupportForm.tsx";
import { AnswerBlock } from "../_components/AnswerBlock.tsx";
import { JsonLds } from "../_components/JsonLd.tsx";
import { useSiteLd } from "../_components/site-ld.ts";
import type { Tr } from "../_components/offers.tsx";

// `/support` (contact.html, without the map and the newsletter box): how to get support. Owner decision
// 2026-11-13 (WPU-Z7): support is given through support requests only. There is no support phone and no
// support e-mail, so the page shows neither, and no contact block with the company address (a deviation
// from 16.8; the company name and address stay in the footer of every page). A customer opens and
// follows requests in the panel (/support/new, /support/requests): a visitor without a session is sent
// to the sign-in first and comes back (the panel's `next`, U12). A visitor without an account uses the
// form below and gets the answer by e-mail.

export function SupportContent({
  locale,
  origin,
  nonce,
}: {
  locale: Locale;
  origin: string | null;
  nonce: string | undefined;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  const p = (path: string): string => localePath(locale, path);
  const site = useSiteLd(locale);
  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          ...site(o, {
            path: "/support",
            name: t("meta.support.title"),
            description: t("meta.support.description"),
            answer: true,
          }),
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
                {/* WPU-Z16: the lead is the answer block of the page. */}
                <AnswerBlock text={t("support.lead")} />
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
                <h2 className="h4 mergecolor">{t("support.customerTitle")}</h2>
                <p className="seccolor">{t("support.customerText")}</p>
                <Button variant="primary" href={p("/support/new")} className="me-2 mb-2">
                  {t("support.newCta")}
                </Button>
                <Button variant="tertiary" href={p("/support/requests")} className="mb-2">
                  {t("support.requestsCta")}
                </Button>
              </div>
              <div className="col-md-6">
                <h2 className="h4 mergecolor">{t("support.visitorTitle")}</h2>
                <p className="seccolor">{t("support.visitorText")}</p>
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
      <section id="write" className="exapath pb-80 noimage bg-seccolorstyle">
        <div className="container">
          <div className="sec-main sec-up mb-0 sec-bg1 bg-seccolorstyle nomargin noshadow">
            <div className="row">
              <div className="col-lg-8">
                <h2 className="h4 mergecolor">{t("support.form.title")}</h2>
                <p className="seccolor">{t("support.form.lead")}</p>
                <PublicSupportForm />
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
