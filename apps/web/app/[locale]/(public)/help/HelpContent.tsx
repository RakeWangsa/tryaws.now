import { Button } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { breadcrumbLd, faqLd } from "../../../../server/public/seo.ts";
import { AnswerBlock } from "../_components/AnswerBlock.tsx";
import { FaqList } from "../_components/FaqList.tsx";
import { JsonLds } from "../_components/JsonLd.tsx";
import { useSiteLd } from "../_components/site-ld.ts";
import type { Tr } from "../_components/offers.tsx";

// `/help` (faq.html): the answer block (WPU-Z16), then the questions as a description list with
// every answer in the HTML. The four required answers of 16.8 come first: is this real AWS, an AWS
// account or console, who bills and supports, where the data is. WPU-Z16 adds the questions people
// ask AI assistants about the offer: the VAT invoice and refunds.

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
  "vatInvoice",
  "refunds",
] as const;

export function HelpContent({
  locale,
  origin,
  nonce,
}: {
  locale: Locale;
  origin: string | null;
  nonce: string | undefined;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  const tAws = useTranslations("Aws");
  const site = useSiteLd(locale);
  const items = FAQ_KEYS.map((key) => ({
    question: t(`help.items.${key}.q`),
    answer: t(`help.items.${key}.a`),
  }));
  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          ...site(o, {
            path: "/help",
            name: t("meta.help.title"),
            description: t("meta.help.description"),
            answer: true,
          }),
          breadcrumbLd(o, locale, [
            { name: t("crumb.home"), path: "/" },
            { name: t("help.heading"), path: "/help" },
          ]),
          faqLd(items),
        ]}
      />
      <div className="top-header">
        <div className="container">
          <div className="row">
            <div className="col-lg-12">
              <div className="wrapper">
                <h1 className="heading mb-0">{t("help.heading")}</h1>
                <AnswerBlock text={t("help.answer")} />
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
          <FaqList items={items} />
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
