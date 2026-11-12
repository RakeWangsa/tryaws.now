import { quote } from "@tc/core";
import { formatMoney } from "@tc/ui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { publicBn } from "../../../messages/public-bn.ts";
import { publicEn } from "../../../messages/public-en.ts";
import type { PublicCatalog } from "../../../server/public/catalog.ts";
import { wholeTakaUp } from "../../../server/public/seo.ts";
import {
  FIXTURE_FX,
  FIXTURE_ROWS,
  FIXTURE_RULE,
  NONCE,
  UNAVAILABLE,
  openCatalog,
} from "./public.fixtures.ts";
import { renderers } from "./public-states.tsx";
import type { Renderer } from "./public-states.tsx";

// The server action is replaced: the page only needs a function to post to.
vi.mock("./products/[family]/actions.ts", () => ({
  notifyMeAction: async () => ({ status: "idle" }),
}));

const SHORT = {
  bn: "১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।",
  en: "100% AWS infrastructure. Built on Amazon Lightsail.",
};
const TRADEMARK =
  "Amazon Web Services, AWS, Amazon Lightsail and Amazon Route 53 are trademarks of Amazon.com, Inc. or its affiliates.";
const LONG_EN =
  "Every server, database and storage resource you buy here is an Amazon Lightsail resource running in an AWS Region (Singapore or Mumbai).";

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let all: Record<string, Renderer>;
let open: PublicCatalog;
beforeAll(async () => {
  open = await openCatalog();
  all = renderers(open, UNAVAILABLE);
});

const LOCALES = ["bn", "en"] as const;
const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

describe("every public page, in bn and en (U1, U4, U6, U11, 16.8)", () => {
  it("has the landmarks, exactly one h1, the AWS short statement and the trademark line", () => {
    for (const [id, render] of Object.entries(all)) {
      for (const locale of LOCALES) {
        const page = render(locale);
        const where = `${id} ${locale}`;
        expect(count(page, /<h1[\s>]/g), `${where}: one h1`).toBe(1);
        expect(count(page, /<main[\s>]/g), `${where}: one main`).toBe(1);
        expect(page, where).toContain("<header");
        expect(page, where).toContain("<nav");
        expect(page, where).toContain("<footer");
        expect(page, where).toContain(escape(SHORT[locale]));
        expect(page, `${where}: trademark line`).toContain(TRADEMARK);
        expect(page, `${where}: skip link`).toContain('href="#main"');
      }
    }
  });

  it("has no inline style, no event handler attribute and no image without alt text (U4, a11y)", () => {
    for (const [id, render] of Object.entries(all)) {
      for (const locale of LOCALES) {
        const page = render(locale);
        expect(page, `${id} ${locale}`).not.toMatch(/\sstyle="/);
        expect(page, `${id} ${locale}`).not.toMatch(/\son[a-z]+="/);
        for (const img of page.match(/<img\b[^>]*>/g) ?? []) {
          expect(img, `${id} ${locale}`).toMatch(/\balt="/);
          // A size on every image: no layout shift when it loads (Lighthouse CLS).
          expect(img, `${id} ${locale}`).toMatch(/\bwidth="\d+"/);
          expect(img, `${id} ${locale}`).toMatch(/\bheight="\d+"/);
        }
        // Text a visitor reads is real text, and a link has a name.
        for (const a of page.match(/<a\b[^>]*>[^]*?<\/a>/g) ?? []) {
          const named = a.replace(/<[^>]*>/g, "").trim() !== "" || /aria-label="[^"]+"/.test(a);
          expect(named, `${id} ${locale}: ${a.slice(0, 80)}`).toBe(true);
        }
        // Nothing from a third-party origin (U3): every URL in an attribute is local or a mailto/tel.
        for (const url of page.match(/(?:src|href)="https?:\/\/[^"]+"/g) ?? []) {
          expect(url, `${id} ${locale}`).toMatch(/cloud\.example\.test|schema\.org/);
        }
      }
    }
  });

  it("names Amazon Lightsail in the first paragraph of the pages that sell (16.8)", () => {
    for (const id of ["home.data", "cloud.data", "help.data"]) {
      expect(all[id]!("en")).toContain(LONG_EN);
    }
    for (const id of ["home.data", "pricing.data", "cloud.data"]) {
      expect(all[id]!("en")).toContain("Amazon Lightsail");
    }
  });

  it("never shows an account id, an ARN or an internal name (U6, R11)", () => {
    for (const [id, render] of Object.entries(all)) {
      for (const locale of LOCALES) {
        // The text of the page: tags (and their class names, which start with tc-) are left out.
        const text = render(locale).replace(/<[^>]*>/g, " ");
        expect(text, id).not.toMatch(/arn:aws/);
        expect(text, id).not.toMatch(/\b\d{12}\b/);
        expect(text, id).not.toMatch(/\btc-[a-z]+-[a-z0-9]+/);
      }
    }
  });
});

describe("prices equal the pricing engine's output (WPP-T1, R4)", () => {
  const expectedMinor = (): bigint[] => {
    const rows = [...(FIXTURE_ROWS["linux_instance"] ?? []), ...(FIXTURE_ROWS["database"] ?? [])];
    return rows.map(
      (r) =>
        quote({ awsPriceUsd: r.awsPriceUsd, fxRate: FIXTURE_FX, rule: FIXTURE_RULE }).totalMinor,
    );
  };

  it("pricing, cloud servers and home show only whole-taka-up amounts of engine totals", () => {
    for (const locale of LOCALES) {
      const allowed = new Set(
        expectedMinor().map((minor) => formatMoney(minor, { locale, mode: "wholeUp" })),
      );
      for (const id of ["pricing.data", "cloud.data", "home.data"]) {
        const page = all[id]!(locale);
        const shown = page.match(/৳[0-9০-৯,.]+/g) ?? [];
        expect(shown.length, `${id} ${locale} shows prices`).toBeGreaterThan(0);
        for (const amount of shown) expect(allowed, `${id} ${locale} ${amount}`).toContain(amount);
      }
    }
  });

  it("shows the price of every open offer on the pricing page and none of a family whose flag is off", () => {
    for (const locale of LOCALES) {
      const page = all["pricing.data"]!(locale);
      for (const row of FIXTURE_ROWS["linux_instance"] ?? []) {
        const total = quote({
          awsPriceUsd: row.awsPriceUsd,
          fxRate: FIXTURE_FX,
          rule: FIXTURE_RULE,
        });
        expect(page, row.id).toContain(formatMoney(total.totalMinor, { locale, mode: "wholeUp" }));
      }
      const windows = quote({ awsPriceUsd: "9.0000", fxRate: FIXTURE_FX, rule: FIXTURE_RULE });
      const windowsText = formatMoney(windows.totalMinor, { locale, mode: "wholeUp" });
      expect(page).not.toContain(`${windowsText}<`);
    }
  });

  it("shows the specification of each location: Mumbai and Singapore differ in data transfer", () => {
    const page = all["pricing.data"]!("en");
    expect(page).toContain("1000 GB");
    expect(page).toContain("2000 GB");
    expect(page).toContain("Singapore");
    expect(page).toContain("Mumbai");
  });

  it("says the prices include VAT and fees and are for 30 days", () => {
    expect(all["pricing.data"]!("en")).toContain(escape(publicEn.Public.common.priceNote));
    expect(all["pricing.data"]!("bn")).toContain(escape(publicBn.Public.common.priceNote));
  });

  it("shows no price and says so when the catalog is unavailable (R16)", () => {
    for (const id of ["home.unavailable", "pricing.unavailable", "cloud.unavailable"]) {
      for (const locale of LOCALES) {
        const page = all[id]!(locale);
        expect(page, id).not.toContain("৳");
        expect(page, id).toContain(
          escape(
            locale === "bn"
              ? publicBn.Public.common.unavailableTitle
              : publicEn.Public.common.unavailableTitle,
          ),
        );
      }
    }
  });

  it("the JSON-LD offers are in BDT with the same whole-taka-up price", () => {
    const blocks = jsonLd(all["pricing.data"]!("en"));
    const product = blocks.find((b) => b["@type"] === "Product") as {
      offers: { priceCurrency: string; price: string }[];
    };
    const prices = (FIXTURE_ROWS["linux_instance"] ?? [])
      .concat(FIXTURE_ROWS["database"] ?? [])
      .map((r) =>
        wholeTakaUp(
          quote({ awsPriceUsd: r.awsPriceUsd, fxRate: FIXTURE_FX, rule: FIXTURE_RULE }).totalMinor,
        ),
      );
    expect(product.offers.map((o) => o.price).sort()).toEqual([...prices].sort());
    expect(new Set(product.offers.map((o) => o.priceCurrency))).toEqual(new Set(["BDT"]));
  });
});

function jsonLd(page: string): Record<string, unknown>[] {
  return [...page.matchAll(/<script type="application\/ld\+json"([^>]*)>([^<]*)<\/script>/g)].map(
    (m) => {
      expect(m[1]).toContain(`nonce="${NONCE}"`);
      return JSON.parse(m[2] as string) as Record<string, unknown>;
    },
  );
}

describe("structured data (WPP-T3)", () => {
  it("home has Organization and BreadcrumbList; help has FAQPage; products have Product", () => {
    const types = (id: string) => jsonLd(all[id]!("en")).map((b) => b["@type"]);
    expect(types("home.data")).toEqual(["Organization", "BreadcrumbList"]);
    expect(types("help.data")).toEqual(["BreadcrumbList", "FAQPage"]);
    expect(types("pricing.data")).toEqual(["BreadcrumbList", "Product"]);
    expect(types("cloud.data")).toEqual(["BreadcrumbList", "FAQPage", "Product"]);
    expect(types("support.data")).toEqual(["BreadcrumbList"]);
  });

  it("the blocks contain no raw '<' (they cannot end the script block)", () => {
    for (const [id, render] of Object.entries(all)) {
      const page = render("en");
      for (const m of page.matchAll(
        /<script type="application\/ld\+json"[^>]*>([^<]*)<\/script>/g,
      )) {
        expect(m[1], id).not.toContain("<");
      }
      // Besides the data blocks the only script is the form replay of React (Next puts the nonce on it).
      const others = (page.match(/<script\b[^>]*>[^]*?<\/script>/g) ?? []).filter(
        (script) => !script.startsWith('<script type="application/ld+json"'),
      );
      for (const script of others) expect(script, id).toContain('addEventListener("submit"');
    }
  });
});

describe("/help (WPP-T2)", () => {
  it("has at least ten questions and the four required answers, in both locales", () => {
    for (const locale of LOCALES) {
      const page = all["help.data"]!(locale);
      const items = (locale === "bn" ? publicBn : publicEn).Public.help.items;
      expect(Object.keys(items).length).toBeGreaterThanOrEqual(10);
      for (const key of ["realAws", "noAccount", "billing", "dataLocation"] as const) {
        expect(page, `${locale} ${key} question`).toContain(escape(items[key].q));
        expect(page, `${locale} ${key} answer`).toContain(escape(items[key].a));
      }
    }
    const en = all["help.data"]!("en");
    expect(en).toContain("Yes, 100%");
    expect(en).toContain("AWS Singapore");
  });

  it("the FAQ JSON-LD lists every question", () => {
    const faq = jsonLd(all["help.data"]!("en")).find((b) => b["@type"] === "FAQPage") as {
      mainEntity: unknown[];
    };
    expect(faq.mainEntity).toHaveLength(Object.keys(publicEn.Public.help.items).length);
  });
});

describe("/support and /legal (WPP-T2)", () => {
  it("support invents no phone number or address: both say they are coming", () => {
    for (const locale of LOCALES) {
      const page = all["support.data"]!(locale);
      const t = (locale === "bn" ? publicBn : publicEn).Public.support;
      expect(page).toContain(escape(t.phonePending));
      expect(page).toContain(escape(t.emailPending));
      expect(page).not.toMatch(/href="(tel|mailto):/);
    }
  });

  it("every legal document is marked as a draft placeholder, with the sidebar of all four", () => {
    for (const doc of ["terms", "privacy", "acceptable-use", "refund"]) {
      for (const locale of LOCALES) {
        const page = all[`legal.${doc}`]!(locale);
        const t = (locale === "bn" ? publicBn : publicEn).Public.legal;
        expect(page, `${doc} ${locale}`).toContain(escape(t.draftTitle));
        expect(page, `${doc} ${locale}`).toContain(escape(t.version));
        expect(page).toContain('aria-current="page"');
        for (const other of ["terms", "privacy", "acceptable-use", "refund"]) {
          expect(page).toContain(other === "terms" ? "/legal/terms" : `/legal/${other}`);
        }
      }
    }
  });

  it("the English home page links the language switch to the same page", () => {
    expect(all["help.data"]!("en")).toContain('href="/help"');
    expect(all["help.data"]!("bn")).toContain('href="/en/help"');
  });
});

describe("a family whose flag is off (WPP-T4, R12)", () => {
  it("shows the coming soon page with a notify-me form that posts the family and an e-mail", () => {
    for (const locale of LOCALES) {
      const page = all["family.soon"]!(locale);
      const t = (locale === "bn" ? publicBn : publicEn).Public;
      expect(page).toContain(escape(t.soon.text));
      expect(page).toContain('name="family"');
      expect(page).toContain('value="databases"');
      expect(page).toContain('name="email"');
      expect(page).toContain('type="email"');
      expect(page).toContain(escape(t.soon.submit));
      expect(page).not.toContain("৳");
    }
  });

  it("an open family has no form", () => {
    const page = all["family.open"]!("en");
    expect(page).not.toContain('name="family"');
    expect(page).not.toContain("<form");
  });
});

describe("the maintenance page (WPP-T2)", () => {
  it("says it is maintenance, in the public frame", () => {
    expect(all["maintenance.data"]!("en")).toContain(
      escape(publicEn.Public.system.maintenanceTitle),
    );
    expect(all["maintenance.data"]!("bn")).toContain(
      escape(publicBn.Public.system.maintenanceTitle),
    );
  });
});
