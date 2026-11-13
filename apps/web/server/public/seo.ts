import type { Metadata } from "next";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";

// Metadata and structured data of the public pages (16.8). Structured data is built here, on the
// server, from fixed fields and the texts of the page; it is serialised with every character that
// could end a script block escaped, so no text of a catalog or of a message can break out of it.

export const SITE_NAME = "TryAWS.now";

export interface PageMeta {
  /** A plain origin without a final slash (WebConfig.appOrigin); null when the site has none configured. */
  origin: string | null;
  locale: Locale;
  /** The path without the locale prefix, for example "/pricing". */
  path: string;
  title: string;
  description: string;
  /** false for a page that exists but must not be indexed (a coming soon page). */
  index?: boolean;
}

/** Title, description, canonical URL, `hreflang` for bn and en, robots and Open Graph. */
export function pageMetadata(meta: PageMeta): Metadata {
  const index = meta.index !== false;
  const robots = index ? { index: true, follow: true } : { index: false, follow: false };
  const origin = meta.origin;
  if (origin === null) {
    // No origin, no URL: the page keeps its texts and its robots rule, and claims no canonical (R16).
    return {
      title: meta.title,
      description: meta.description,
      robots,
      icons: { icon: "/brand/symbol.svg" },
    };
  }
  const url = (locale: Locale): string => origin + localePath(locale, meta.path);
  return {
    metadataBase: new URL(origin),
    title: meta.title,
    description: meta.description,
    alternates: {
      canonical: url(meta.locale),
      languages: { bn: url("bn"), en: url("en"), "x-default": url("bn") },
    },
    robots,
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: meta.title,
      description: meta.description,
      url: url(meta.locale),
      locale: meta.locale === "bn" ? "bn_BD" : "en_US",
      alternateLocale: meta.locale === "bn" ? ["en_US"] : ["bn_BD"],
    },
    icons: { icon: "/brand/symbol.svg" },
  };
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON for a `<script type="application/ld+json">` block. `<`, `>`, `&` and the two Unicode line
 * separators are escaped, so the text cannot contain `</script>` or an HTML comment, whatever a
 * message or a catalog field holds.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

/**
 * The price of an offer as the decimal text of whole taka rounded up, the same value the plan
 * cards show (`MoneyText` mode "wholeUp"). Integer division of a bigint; no float (R4).
 */
export function wholeTakaUp(minor: bigint): string {
  if (typeof minor !== "bigint" || minor < 0n) {
    throw new TypeError("wholeTakaUp: minor must be a non-negative bigint of paisa");
  }
  return ((minor + 99n) / 100n).toString();
}

type Ld = Record<string, unknown>;

export function organizationLd(origin: string): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: origin + "/",
    logo: origin + "/brand/symbol.svg",
  };
}

export function breadcrumbLd(
  origin: string,
  locale: Locale,
  items: readonly { name: string; path: string }[],
): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: origin + localePath(locale, item.path),
    })),
  };
}

export function faqLd(items: readonly { question: string; answer: string }[]): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

export interface ProductOffer {
  /** The name of the plan at its location. */
  name: string;
  /** US dollars, the decimal text of the pricing engine (WPU-Y4). */
  priceUsd: string;
  url: string;
}

/** A product with one offer in USD for each plan; the price is the text the page shows (WPU-Y4). */
export function productLd(input: {
  name: string;
  description: string;
  url: string;
  offers: readonly ProductOffer[];
}): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    description: input.description,
    url: input.url,
    brand: { "@type": "Brand", name: SITE_NAME },
    offers: input.offers.map((offer) => ({
      "@type": "Offer",
      name: offer.name,
      url: offer.url,
      priceCurrency: "USD",
      price: offer.priceUsd,
      availability: "https://schema.org/InStock",
    })),
  };
}
