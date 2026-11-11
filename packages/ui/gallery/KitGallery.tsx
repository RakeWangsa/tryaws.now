import { useLocale, useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { toLocale } from "../components/types.ts";
import { localeHrefs, localePath } from "../runtime/index.ts";
import { AttributeSwitch } from "./AttributeSwitch.tsx";
import { GALLERY_SHELLS } from "./shells.ts";
import { Aws } from "./sections/Aws.tsx";
import { Choices } from "./sections/Choices.tsx";
import { Data } from "./sections/Data.tsx";
import { Format } from "./sections/Format.tsx";
import { Forms } from "./sections/Forms.tsx";
import { Overlays } from "./sections/Overlays.tsx";
import { States } from "./sections/States.tsx";
import { Surfaces } from "./sections/Surfaces.tsx";

const GROUPS: readonly { id: string; Section: () => ReactElement }[] = [
  { id: "surfaces", Section: Surfaces },
  { id: "choices", Section: Choices },
  { id: "data", Section: Data },
  { id: "forms", Section: Forms },
  { id: "overlays", Section: Overlays },
  { id: "states", Section: States },
  { id: "format", Section: Format },
  { id: "aws", Section: Aws },
];

/**
 * Every component of the kit with sample data (16.16). It has no shell, so the page shows the body
 * attributes of its own app; the switch sets the other set. Server component.
 */
export function KitGallery({ app = "web" }: { app?: "web" | "admin" }): ReactElement {
  const t = useTranslations("Gallery");
  const locale = toLocale(useLocale());
  const other = locale === "bn" ? "en" : "bn";
  return (
    <div className="bg-colorstyle">
      <div className="container tc-gallery pt-4">
        <h1 className="h3 mergecolor">{t("title")}</h1>
        <p className="seccolor">{t("intro")}</p>
        <nav aria-label={t("nav.label")} data-gallery-nav className="mb-4">
          <ul className="list-inline mb-0">
            <li className="list-inline-item">
              <a
                className="golink"
                href={localeHrefs("/dev/ui")[other]}
                hrefLang={other}
                lang={other}
              >
                {t("nav.otherLocale")}
              </a>
            </li>
            {GALLERY_SHELLS[app].map((shell) => (
              <li key={shell} className="list-inline-item">
                <a className="golink" href={localePath(locale, `/dev/ui/${shell}`)}>
                  {t("nav.shells")}: {t(`nav.shell.${shell}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <AttributeSwitch app={app} />
        {GROUPS.map(({ id, Section }) => (
          <section key={id} data-gallery-group={id} className="mb-5">
            <h2 className="h4 mergecolor mb-4">{t(`groups.${id}`)}</h2>
            <Section />
          </section>
        ))}
      </div>
    </div>
  );
}
