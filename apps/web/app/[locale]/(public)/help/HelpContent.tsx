import { Accordion, Button } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { breadcrumbLd, faqLd } from "../../../../server/public/seo.ts";
import { JsonLd } from "../_components/JsonLd.tsx";
import type { Tr } from "../_components/offers.tsx";

// `/help` (faq.html): the questions in an Accordion. The four required answers of 16.8 come first:
// is this real AWS, an AWS account or console, who bills and supports, where the data is.

export const FAQ_KEYS = [
  "realAws",
  "noAccount",
  "billing",
  "dataLocation",
  "payment",
  "priceIncludes",
  "locations",
  "identity",
  "products",
  "port25",
  "support",
  "bdt",
] as const;

export function HelpContent({
  locale,
  origin,
  nonce,
}: {
  locale: Locale;
  origin: string;
  nonce: string | undefined;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  const tAws = useTranslations("Aws");
  const items = FAQ_KEYS.map((key) => ({
    id: key,
    title: t(`help.items.${key}.q`),
    answer: t(`help.items.${key}.a`),
  }));
  return (
    <>
      <JsonLd
        data={breadcrumbLd(origin, locale, [
          { name: t("crumb.home"), path: "/" },
          { name: t("help.heading"), path: "/help" },
        ])}
        nonce={nonce}
      />
      <JsonLd
        data={faqLd(items.map((item) => ({ question: item.title, answer: item.answer })))}
        nonce={nonce}
      />
      <div className="top-header">
        <div className="container">
          <div className="row">
            <div className="col-lg-12">
              <div className="wrapper">
                <h1 className="heading mb-0">{t("help.heading")}</h1>
                <p className="seccolor">{t("help.lead")}</p>
                <p className="seccolor">{tAws("long")}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <section id="gotop" className="blog motpath pb-80 bg-colorstyle">
        <div className="container">
          <h2 className="section-heading mergecolor mt-80">{t("help.listTitle")}</h2>
          <Accordion
            headingLevel={3}
            defaultOpenId="realAws"
            items={items.map((item) => ({
              id: item.id,
              title: item.title,
              content: <p className="seccolor">{item.answer}</p>,
            }))}
          />
          <h2 className="h4 mergecolor mt-5">{t("help.stillTitle")}</h2>
          <p className="seccolor">{t("help.stillText")}</p>
          <Button variant="primary" href={localePath(locale, "/support")}>
            {t("support.heading")}
          </Button>
        </div>
      </section>
    </>
  );
}
