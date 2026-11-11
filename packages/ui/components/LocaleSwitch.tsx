import { useTranslations } from "next-intl";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { cx } from "./cx";
import { toLocale, type LinkComponent, type Locale } from "./types";

export interface LocaleSwitchItem {
  locale: Locale;
  href: string;
}

export interface LocaleSwitchProps {
  current: Locale;
  /** Exactly the two locales, once each. The apps compute the hrefs. */
  items: LocaleSwitchItem[];
  linkAs?: LinkComponent;
}

/** The anchor props a locale link carries; a framework link (such as next/link) passes them to its `<a>`. */
type LocaleLinkProps = ComponentProps<LinkComponent> & {
  hrefLang: string;
  lang: string;
  "aria-current"?: "true";
};

/** The language pills of the mockup (header.html, `section#drop-lng`). Switching is a plain navigation. */
export function LocaleSwitch({ current, items, linkAs }: LocaleSwitchProps) {
  const t = useTranslations("kit.locale");
  const seen = items.map((item) => toLocale(item.locale));
  if (items.length !== 2 || !seen.includes("bn") || !seen.includes("en")) {
    throw new RangeError("LocaleSwitch needs exactly the locales bn and en, once each");
  }
  const Link = (linkAs ?? "a") as ComponentType<LocaleLinkProps> | "a";

  return (
    <div
      className="btn-group btn-group-toggle toplang tc-locale-switch"
      role="group"
      aria-label={t("label")}
    >
      {items.map((item, index): ReactNode => {
        const active = item.locale === current;
        const props: LocaleLinkProps = {
          href: item.href,
          hrefLang: item.locale,
          lang: item.locale,
          className: cx(
            "btn btn-secondary tc-locale-link",
            index === 0 && "me-1",
            active && "active",
          ),
          ...(active ? { "aria-current": "true" as const } : {}),
        };
        const text = item.locale === "bn" ? t("bn") : t("en");
        return Link === "a" ? (
          <a key={item.locale} {...props}>
            {text}
          </a>
        ) : (
          <Link key={item.locale} {...props}>
            {text}
          </Link>
        );
      })}
    </div>
  );
}
