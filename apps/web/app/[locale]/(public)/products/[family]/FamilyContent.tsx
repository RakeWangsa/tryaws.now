import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FamilyPage } from "../../../../../server/public/indexing.ts";
import { breadcrumbLd } from "../../../../../server/public/seo.ts";
import { JsonLd } from "../../_components/JsonLd.tsx";
import type { Tr } from "../../_components/offers.tsx";
import { NotifyForm } from "./NotifyForm.tsx";

// The page of a product family that is not Cloud Server (P1, 16.8, 16.13). A family whose flag is off
// (or cannot be read) shows the coming soon page with "notify me" (the structure of soon.html and
// 404.html: one state in the public frame). A family whose flag is on gets a short page that sends
// the customer to the panel; its full product page follows the gate of the family.

export function FamilyContent({
  locale,
  page,
  open,
  origin,
  nonce,
}: {
  locale: Locale;
  page: FamilyPage;
  /** true only when the flag is read and on. */
  open: boolean;
  origin: string;
  nonce: string | undefined;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  const tAws = useTranslations("Aws");
  const name = t(`family.${page.nameKey}`);
  const crumbs = breadcrumbLd(origin, locale, [
    { name: t("crumb.home"), path: "/" },
    { name, path: `/products/${page.slug}` },
  ]);

  if (!open) {
    return (
      <>
        <JsonLd data={crumbs} nonce={nonce} />
        <section className="sec-normal notfound pt-150">
          <div className="container">
            <div className="tc-empty text-center">
              <h1 className="h4 mergecolor">{t("soon.title", { name })}</h1>
              <p className="seccolor">{t("soon.text")}</p>
              <p className="seccolor">{tAws("short")}</p>
              <div className="row justify-content-center">
                <div className="col-md-6 text-start">
                  <NotifyForm family={page.slug} name={name} />
                </div>
              </div>
              <Button variant="tertiary" href={localePath(locale, "/pricing")} className="mt-3">
                {t("soon.back")}
              </Button>
            </div>
          </div>
        </section>
      </>
    );
  }
  return (
    <>
      <JsonLd data={crumbs} nonce={nonce} />
      <div className="top-header">
        <div className="container">
          <div className="wrapper">
            <h1 className="heading">{name}</h1>
            <p className="seccolor">{tAws("long")}</p>
          </div>
        </div>
      </div>
      <section className="sec-normal bg-colorstyle">
        <div className="container">
          <EmptyState
            title={name}
            description={t("familyOpen.text")}
            action={
              <Button variant="primary" href={localePath(locale, "/login")}>
                {t("common.login")}
              </Button>
            }
          />
        </div>
      </section>
    </>
  );
}
