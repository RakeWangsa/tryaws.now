import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { LEGAL_DOCS } from "../../../../server/public/indexing.ts";
import type { LegalDoc } from "../../../../server/public/indexing.ts";
import { breadcrumbLd } from "../../../../server/public/seo.ts";
import { JsonLds } from "../_components/JsonLd.tsx";
import { useSiteLd } from "../_components/site-ld.ts";
import type { Tr } from "../_components/offers.tsx";

// `/legal/[doc]` (legal.html): the sidebar of documents and the document. The texts (WPU-Z7,
// messages/legal-bn.ts and legal-en.ts) are written from the specification and the owner decisions:
// numbered sections in plain language, and a bracketed "to be decided" note where a fact is open.
// WPU-Y6: the owner approved the texts on 2026-11-14; the page shows no draft notice.

/**
 * The sections of each document, in order. Each has a numbered `title` and the paragraphs p1, p2, ...
 * public-pages.test.tsx checks that every section of the messages is rendered, in this order.
 */
const LEGAL_SECTIONS: Readonly<Record<LegalDoc, readonly string[]>> = {
  terms: [
    "provider",
    "service",
    "account",
    "identity",
    "wallet",
    "prices",
    "orders",
    "renewal",
    "notRenewed",
    "usage",
    "suspension",
    "invoices",
    "support",
    "liability",
    "changes",
    "law",
  ],
  "acceptable-use": [
    "scope",
    "aws",
    "mining",
    "transfer",
    "cdn",
    "email",
    "suspend",
    "report",
    "more",
  ],
  privacy: [
    "controller",
    "collect",
    "why",
    "storage",
    "share",
    "security",
    "cookies",
    "retention",
    "rights",
  ],
  refund: ["wallet", "failed", "period", "reversal", "payout", "review", "ask"],
};

/** The acceptable use policy passes on the AWS rules, so it opens with the long AWS statement of 16.13. */
const OPENS_WITH_AWS_STATEMENT: readonly LegalDoc[] = ["acceptable-use"];

/** The keys p1, p2, ... of a section, as far as the messages have them. */
function paragraphKeys(t: Tr, section: string): string[] {
  const keys: string[] = [];
  for (let n = 1; t.has(`${section}.p${n}`); n++) keys.push(`${section}.p${n}`);
  return keys;
}

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
  const tAws = useTranslations("Aws");
  const tShell = useTranslations("Shell");
  // The provider's name, address, BIN and trade licence are those of the footer (Section 1, WPU-Y6), and
  // the brand is the shell's (WPU-Z8): one source for each.
  const provider = {
    company: tShell("footer.companyName"),
    address: tShell("footer.address"),
    bin: tShell("footer.bin"),
    tradeLicense: tShell("footer.tradeLicense"),
    brand: tShell("brand"),
  };
  const title = t(`legal.docs.${doc}.title`);
  const site = useSiteLd(locale);
  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          ...site(o, {
            path: `/legal/${doc}`,
            name: title,
            description: t("meta.legal.descriptionOf", { title }),
            answer: false,
          }),
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
                    <div className="wrapper mt-5 bg-seccolorstyle noshadow">
                      <h2 className="h5 mergecolor">
                        <b>{title}</b>{" "}
                        <span className="float-end c-grey seccolor">{t("legal.version")}</span>
                      </h2>
                      <hr />
                      {OPENS_WITH_AWS_STATEMENT.includes(doc) ? (
                        <div className="blog-info">
                          <p className="seccolor">{tAws("long")}</p>
                        </div>
                      ) : null}
                      {LEGAL_SECTIONS[doc].map((section) => {
                        const base = `legal.docs.${doc}.sections.${section}`;
                        return (
                          <div key={section}>
                            <h3 className="h6 mergecolor mt-4">{t(`${base}.title`)}</h3>
                            {paragraphKeys(t, base).map((key) => (
                              <div key={key} className="blog-info">
                                <p className="seccolor">{t(key, provider)}</p>
                              </div>
                            ))}
                          </div>
                        );
                      })}
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
