import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Locale } from "@tc/ui/runtime";
import { publicBn } from "../../../../messages/public-bn.ts";
import { publicEn } from "../../../../messages/public-en.ts";
import type { PublicCatalog } from "../../../../server/public/catalog.ts";
import { HomeContent } from "../HomeContent.tsx";
import { html } from "../public-states.tsx";
import { NONCE, ORIGIN, UNAVAILABLE, openCatalog } from "../public.fixtures.ts";
import { HOME_FAQ_KEYS, HOME_PLAN_LIMIT, homePlans, homeProducts } from "./home-data.ts";

// WPU-X13: the redesigned home page. The claims of the page are the claims of the repository: the
// tests pin the structure (what is where), that the page never promises a product whose flag is off,
// that no number or superlative was invented, and that the prices stay the engine's output.

vi.mock("../products/[family]/actions.ts", () => ({
  notifyMeAction: async () => ({ status: "idle" }),
}));

const ALL_FLAGS = [
  "linux_instance",
  "database",
  "disk",
  "static_ip",
  "backup",
  "cdn",
  "dns_zone",
  "domain",
];

const render = (catalog: PublicCatalog, locale: Locale): string =>
  html(<HomeContent locale={locale} catalog={catalog} origin={ORIGIN} nonce={NONCE} />, locale);
const text = (page: string): string =>
  page
    .replace(/<script[^]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");

let open: PublicCatalog;
let everything: PublicCatalog;
let none: PublicCatalog;
beforeAll(async () => {
  open = await openCatalog();
  everything = await openCatalog(ALL_FLAGS);
  none = await openCatalog([]);
});

describe("structure (WPU-X13)", () => {
  it("has the sections in the order hero, trust, steps, products, plans, comparison, locations, FAQ, call to action", () => {
    for (const locale of ["bn", "en"] as const) {
      const page = render(open, locale);
      const marks = [
        'tc-hero"',
        "tc-trust",
        'class="tc-step-number"',
        "tc-tile-soon",
        'id="plans"',
        "table compare",
        "tc-location-code",
        "accordion faq",
        "tc-cta-band",
      ].map((mark) => page.indexOf(mark));
      expect(
        marks.every((i) => i >= 0),
        `${locale}: every section is there ${marks}`,
      ).toBe(true);
      expect(
        [...marks].sort((a, b) => a - b),
        locale,
      ).toEqual(marks);
    }
  });

  it("shows one headline, one lead and two buttons in the hero, and no second paragraph of the same text", () => {
    const hero = /<section class="top-header[^]*?<\/section>/.exec(render(open, "en"))?.[0] ?? "";
    expect((hero.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect((hero.match(/<p\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((hero.match(/class="btn /g) ?? []).length).toBe(2);
    // Bug 1 of the owner's review: the same paragraph twice. Each long text is on the page once.
    for (const locale of ["bn", "en"] as const) {
      const body = text(render(open, locale));
      const tree = locale === "bn" ? publicBn.Public : publicEn.Public;
      for (const sentence of [tree.entity.statement, tree.home.heroLead]) {
        expect(
          body.split(sentence.slice(0, 40)).length - 1,
          `${locale}: ${sentence.slice(0, 40)}`,
        ).toBe(1);
      }
    }
  });

  it("writes the Bengali headline first and a headline that promises something (no AWS account, taka)", () => {
    expect(publicBn.Public.home.heroTitle).toMatch(/টাকায়/);
    expect(publicEn.Public.home.heroTitle).toMatch(/taka/);
  });

  it("draws the panel picture as an inline SVG that screen readers skip, no image file (U13)", () => {
    const page = render(open, "en");
    expect(page).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(page).not.toMatch(/<img\b/);
  });
});

describe("claims (WPU-X13)", () => {
  it("has no invented number, rating, uptime, discount or superlative", () => {
    for (const locale of ["bn", "en"] as const) {
      const body = text(render(everything, locale));
      // The only percentage on the page is the 100% AWS statement.
      for (const m of body.match(/[\d০-৯][\d০-৯.]*\s?%/g) ?? []) {
        expect(m.replace(/\s/g, ""), locale).toMatch(/^(100%|১০০%)$/);
      }
      expect(body, locale).not.toMatch(
        /uptime|SLA|cheapest|best|testimonial|bKash|Nagad|minutes|customers|সবচেয়ে সস্তা|আপটাইম/i,
      );
      expect(body, locale).not.toMatch(/AWS Lightsail|Powered by AWS/i);
    }
  });

  it("names Amazon Lightsail and keeps the long AWS statement once", () => {
    const body = text(render(open, "en"));
    expect(body).toContain("Amazon Lightsail");
    const long =
      "Every server, database and storage resource you buy here is an Amazon Lightsail resource running in an AWS Region (Singapore or Mumbai).";
    expect(body.split(long).length - 1).toBe(1);
  });

  it("states the buy conditions of the no-KYC decision: email, mobile and an authenticator app, no documents", () => {
    const body = text(render(open, "en"));
    expect(body).toContain("an email, a mobile number and an authenticator app");
    expect(body).toContain("No documents are needed");
    expect(body).not.toMatch(/KYC|identity document|passport|national ID/i);
  });
});

describe("the product grid and the feature flags (R12, R16)", () => {
  it("never calls a product open whose flag is off, and says coming soon next to it", () => {
    const states = homeProducts(open);
    expect(states.find((p) => p.key === "server")?.open).toBe(true);
    for (const key of ["disk", "staticIp", "backup", "cdn", "dns", "domain"]) {
      expect(states.find((p) => p.key === key)?.open, key).toBe(false);
    }
    const page = render(open, "en");
    expect((page.match(/Coming soon/g) ?? []).length).toBe(6);
    expect((page.match(/badge bg-success/g) ?? []).length).toBe(1);
  });

  it("shows every product open when every flag is on, and none open when none is", () => {
    expect(homeProducts(everything).every((p) => p.open)).toBe(true);
    expect((render(everything, "en").match(/Coming soon/g) ?? []).length).toBe(0);
    expect(homeProducts(none).some((p) => p.open)).toBe(false);
    expect((render(none, "en").match(/badge bg-success/g) ?? []).length).toBe(0);
  });

  it("a state is told by an icon and a word, not by color alone (U11)", () => {
    const page = render(open, "en");
    expect(page).toMatch(/badge bg-success"><i class="fas fa-check"[^>]*><\/i> Open</);
    expect(page).toMatch(/badge bg-secondary"><i class="fas fa-clock"[^>]*><\/i> Coming soon</);
  });

  it("shows no grid and no plan when the catalog cannot be read", () => {
    expect(homeProducts(UNAVAILABLE)).toEqual([]);
    const page = render(UNAVAILABLE, "en");
    expect(page).not.toContain("tc-tile-soon");
    expect(page).toContain("Prices cannot be shown now");
    expect(page).not.toMatch(/\$\s?\d/);
  });
});

describe("plans (WPU-X13)", () => {
  it("picks one plan for each memory size at its cheapest location, cheapest first, at most four", () => {
    const plans = homePlans(open);
    expect(plans.map((o) => o.specs.ramGb)).toEqual(["1", "4", "8"]);
    expect(plans.length).toBeLessThanOrEqual(HOME_PLAN_LIMIT);
    // The 1 GB plan exists in Singapore at 5.00 and in Mumbai at 4.00: the cheaper location is shown.
    expect(plans[0]?.region).toBe("ap-south-1");
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i]!.priceMinor >= plans[i - 1]!.priceMinor).toBe(true);
    }
    expect(homePlans(UNAVAILABLE)).toEqual([]);
  });

  it("renders those plans as cards, with one Recommended badge, a taka price on each and no dollar (WPU-X16)", () => {
    const page = render(open, "en");
    expect((page.match(/class="top-content/g) ?? []).length).toBe(3);
    expect((page.match(/plans badge feat/g) ?? []).length).toBe(1);
    expect((page.match(/class="price seccolor"><span>৳[\d,]+<\/span>/g) ?? []).length).toBe(3);
    expect(text(page)).not.toMatch(/\$|USD|dollar/i);
  });
});

describe("comparison, locations, FAQ (WPU-X13)", () => {
  it("explains how buying works here in a two column table with a caption, and says nothing about what AWS does", () => {
    const page = render(open, "en");
    const table = /<table class="table compare">[^]*?<\/table>/.exec(page)?.[0] ?? "";
    expect(table).toContain("<caption");
    expect((table.match(/<th scope="col"/g) ?? []).length).toBe(2);
    expect((table.match(/<th scope="row"/g) ?? []).length).toBe(4);
    // WPU-X13 round 2: no claim about AWS billing that the repository cannot show.
    for (const locale of ["bn", "en"] as const) {
      const body = text(render(open, locale));
      expect(body, locale).not.toMatch(
        /international card|billed after use|No invoice in taka|আন্তর্জাতিক কার্ড|ব্যবহারের পরে বিল|চালানপত্র নেই/,
      );
    }
  });

  it("has two location cards that link to the pricing page filtered by region", () => {
    const page = render(open, "en");
    expect(page).toContain("ap-southeast-1");
    expect(page).toContain("ap-south-1");
    expect(page).toContain('href="/en/pricing?region=ap-southeast-1"');
    expect(page).toContain('href="/en/pricing?region=ap-south-1"');
  });

  it("has the eight questions of /help in the same words, visible without a script", () => {
    expect(HOME_FAQ_KEYS.length).toBe(8);
    for (const locale of ["bn", "en"] as const) {
      const page = render(open, locale);
      const tree = (locale === "bn" ? publicBn : publicEn).Public.help.items as Record<
        string,
        { q: string; a: string }
      >;
      for (const key of HOME_FAQ_KEYS) {
        expect(page, `${locale} ${key}`).toContain(tree[key]!.q);
      }
      expect((page.match(/class="panel-wrap"/g) ?? []).length).toBe(8);
    }
  });

  it("ends with a call to action that goes to sign-up and to the prices", () => {
    const band = /<section class="getready[^]*?<\/section>/.exec(render(open, "en"))?.[0] ?? "";
    expect(band).toContain('href="/en/signup"');
    expect(band).toContain('href="/en/pricing"');
  });
});
