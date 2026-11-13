import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { LEGAL_DOCS } from "../../../../server/public/indexing.ts";
import type { LegalDoc } from "../../../../server/public/indexing.ts";
import { breadcrumbLd } from "../../../../server/public/seo.ts";
import { JsonLds } from "../_components/JsonLd.tsx";
import type { Tr } from "../_components/offers.tsx";

// `/legal/[doc]` (legal.html): the sidebar of documents and the document. THE TEXT IS A PLACEHOLDER
// (JOURNEY.md, Needs decision): every section is a one-line stand-in that ends in a marker, and the
// page says in a visible notice that it is a draft. The wording is the legal adviser's (16.8).

const SECTIONS: Readonly<Record<LegalDoc, readonly string[]>> = {
  terms: ["scope", "payment", "suspension"],
  "acceptable-use": ["aws", "mining", "transfer", "suspend"],
  privacy: ["collect", "storage", "rights"],
  refund: ["wallet", "service"],
};

export function LegalContent({
  locale,
  doc,
  origin,
  nonce,
}: {
  locale: Locale;
  doc: LegalDoc;
  origin: string | null;
  nonce: string | undefined;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  const title = t(`legal.docs.${doc}.title`);
  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          breadcrumbLd(o, locale, [
            { name: t("crumb.home"), path: "/" },
            { name: t("legal.heading"), path: "/legal/terms" },
            { name: title, path: `/legal/${doc}` },
          ]),
        ]}
      />
      <div className="top-header">
        <div className="container">
          <div className="row">
            <div className="col-lg-12">
              <div className="wrapper">
                <h1 className="heading mb-0">{title}</h1>
              </div>
            </div>
          </div>
        </div>
      </div>
      <section id="gotop" className="blog motpath pb-80 bg-colorstyle">
        <div className="container">
          <div className="row">
            <div className="col-md-12 col-lg-4">
              <aside id="sidebar" className="sidebar mt-80 sec-bg1 bg-seccolorstyle noshadow">
                <nav className="menu categories" aria-label={t("legal.sidebarLabel")}>
                  <h2 className="h5 mergecolor">
                    <b>{t("legal.sidebarTitle")}</b>
                  </h2>
                  <hr />
                  {LEGAL_DOCS.map((other) => (
                    <div key={other} className="heading pt-2">
                      <a
                        href={localePath(locale, `/legal/${other}`)}
                        className={other === doc ? "active seccolor" : "seccolor"}
                        {...(other === doc ? { "aria-current": "page" as const } : {})}
                      >
                        {t(`legal.docs.${other}.title`)}
                      </a>
                    </div>
                  ))}
                </nav>
              </aside>
            </div>
            <div className="pt-35 col-md-12 col-lg-8">
              <div id="sidebar_content" className="wrap-blog">
                <div className="row">
                  <div className="col-md-12 col-lg-12 knowledge">
                    <div className="alert alert-warning mt-5" role="note">
                      <strong>{t("legal.draftTitle")}</strong> {t("legal.draftText")}
                    </div>
                    <div className="wrapper mt-5 bg-seccolorstyle noshadow">
                      <h2 className="h5 mergecolor">
                        <b>{title}</b>{" "}
                        <span className="float-end c-grey seccolor">{t("legal.version")}</span>
                      </h2>
                      <hr />
                      {SECTIONS[doc].map((section) => (
                        <div key={section} className="blog-info">
                          <p className="seccolor">{t(`legal.docs.${doc}.sections.${section}`)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
