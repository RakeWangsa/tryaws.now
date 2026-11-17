import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { mockupPresent, vendoredThemePresent } from "@tc/ui/theme-present";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { pricingEn } from "./messages/pricing.en.ts";
import { pricingBn } from "./messages/pricing.ts";

const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const OTHER_ID = "0191a000-0000-7000-8000-0000000000ae";
const NOW = new Date("2026-11-12T06:00:00.000Z");

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  pricing: undefined as unknown,
  catalog: undefined as unknown,
  pricingQueries: [] as unknown[],
}));

vi.mock("./server/page-admin.ts", () => ({
  loadPageAdmin: async (locale: string, id: string) => {
    state.asked.push([locale, id]);
    return state.page;
  },
}));
vi.mock("./server/actions.ts", () => ({
  signInAction: async () => ({ error: null }),
  signOutAction: async () => {},
}));
vi.mock("./server/customer-actions.ts", () => ({ customerDecisionAction: async () => {} }));
vi.mock("./server/pricing-actions.ts", () => ({
  saveRuleAction: async () => {},
  setFxAction: async () => {},
  approveFxAction: async () => {},
  setFlagAction: async () => {},
  setImageAction: async () => {},
  setImageMinPowerAction: async () => {},
}));
vi.mock("./server/pricing-data.ts", () => ({
  loadPricing: async (_admin: unknown, raw: unknown) => {
    state.pricingQueries.push(raw);
    return state.pricing;
  },
  loadCatalog: async () => state.catalog,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
    let node = adminMessages[locale === "en" ? "en" : "bn"] as Messages | string | undefined;
    for (const part of namespace.split("."))
      node = typeof node === "object" ? node[part] : undefined;
    return (key: string): string => {
      let value: Messages | string | undefined = node;
      for (const part of key.split("."))
        value = typeof value === "object" ? value[part] : undefined;
      if (typeof value !== "string") throw new Error(`missing ${namespace}.${key}`);
      return value;
    };
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { default: PricingPage } = await import("./app/[locale]/pricing/page.tsx");
const { default: CatalogPage } = await import("./app/[locale]/catalog/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];

const quote = (totalMinor: bigint) => ({
  currency: "BDT",
  fxRate: "122",
  ruleVersion: "r1",
  baseMinor: 100n,
  steps: [],
  totalMinor,
});
const SAMPLES = ["instance_5", "instance_24", "instance_84", "disk_80gb", "backup_1gb_day"];
const previewRows = SAMPLES.map((sampleId, i) => ({
  sampleId,
  awsPriceUsd: "5",
  quantity: "1",
  candidate: quote(BigInt(70000 + i * 100)),
  current: quote(BigInt(65000 + i * 100)),
  deltaMinor: 5000n,
}));

const STEP = { code: "markup", rate: "0.15", base: "subtotal", bn: "মার্কআপ", en: "Markup" };

function pricing(over: Record<string, unknown> = {}) {
  return {
    kind: "ok",
    value: {
      markets: ["BD"],
      market: "BD",
      draft: { market: "BD", family: null, steps: [STEP], from: "", fx: "" },
      submitted: false,
      rules: [
        {
          id: "r2",
          market: "BD",
          productFamily: null,
          steps: [{ code: "markup", rate: "0.15", base: "subtotal" }],
          effectiveFrom: new Date("2026-12-01T00:00:00Z"),
        },
        {
          id: "r1",
          market: "BD",
          productFamily: null,
          steps: [{ code: "markup", rate: "0.10", base: "subtotal" }],
          effectiveFrom: new Date("2026-11-01T00:00:00Z"),
        },
      ],
      fxHistory: [
        { id: "f1", market: "BD", rate: "122.5", effectiveFrom: new Date("2026-11-01T00:00:00Z") },
      ],
      fxInForce: {
        id: "f1",
        market: "BD",
        rate: "122.5",
        effectiveFrom: new Date("2026-11-01T00:00:00Z"),
      },
      pending: null,
      preview: { kind: "none" },
      now: NOW,
      ...over,
    },
  };
}

const FLAGS = [
  "linux_instance",
  "static_ip",
  "backup",
  "disk",
  "windows_instance",
  "database",
  "load_balancer",
  "bucket",
  "container_service",
  "cdn",
  "dns_zone",
  "domain",
].map((key) => ({ key, enabled: key === "linux_instance" }));

function catalog() {
  const row = {
    id: "p1",
    family: "linux_instance",
    awsId: "nano_3_0",
    platform: "linux",
    region: "ap-south-1",
    specs: {},
    awsPriceUsd: "5.0000",
    billingUnit: "month",
    featureFlag: "linux_instance",
    active: true,
    syncedAt: new Date("2026-11-11T00:00:00Z"),
  };
  return {
    kind: "ok",
    value: {
      markets: ["BD"],
      market: "BD",
      flags: FLAGS,
      images: [
        {
          id: "wordpress",
          name: "WordPress",
          kind: "app",
          loginUser: "bitnami",
          regions: ["ap-southeast-1", "ap-south-1"],
          on: true,
          explicit: false,
          minPower: 1000,
          minPowerBy: "default",
          minPowerAdmin: null,
        },
        {
          id: "ubuntu_24_04",
          name: "Ubuntu",
          kind: "os",
          loginUser: "ubuntu",
          regions: [],
          on: false,
          explicit: true,
          minPower: 500,
          minPowerBy: "admin",
          minPowerAdmin: 500,
        },
      ],
      imagesInvalid: false,
      families: [
        {
          family: "linux_instance",
          flag: "linux_instance",
          enabled: true,
          lastSyncedAt: row.syncedAt,
          rows: [
            { row, price: { id: "p1", priceBdt: quote(71250n) } },
            { row: { ...row, id: "p2", awsId: "old_3_0", active: false }, price: null },
          ],
        },
      ],
    },
  };
}

function inProvider(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={adminMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

const as = (role: string) => {
  state.page = { kind: "ok", admin: { adminId: ADMIN_ID, role, ip: "203.0.113.7" } };
};
const params = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
// The own trees of the screens, typed (the English tree has the type of both).
const msgs = (locale: Locale): typeof pricingEn =>
  (locale === "bn" ? pricingBn : pricingEn) as typeof pricingEn;
const sampleText = (locale: Locale, id: string): string =>
  (msgs(locale).AdminPricing.preview.samples as Record<string, string>)[id] ?? "";

beforeEach(() => {
  state.asked = [];
  state.pricingQueries = [];
  as("finance");
  state.pricing = pricing();
  state.catalog = catalog();
});

describe("/pricing", () => {
  it.each(LOCALES)(
    "shows the rate, its history, the rules and the editor in %s",
    async (locale) => {
      const html = inProvider(await PricingPage(params(locale)), locale);
      const m = msgs(locale).AdminPricing;
      expect(html).toContain(m.fx.title);
      expect(html).toContain("122.5");
      expect(html).toContain(m.rules.title);
      expect(html).toContain(m.rules.inForce);
      expect(html).toContain(m.rules.scheduled);
      expect(html).toContain(m.editor.title);
      expect(html).toContain('name="code0"');
      expect(state.asked).toEqual([[locale, "pricing"]]);
    },
  );

  it("shows no preview and offers no save before a preview was asked for", async () => {
    const html = inProvider(await PricingPage(params("en")), "en");
    expect(html).not.toContain(msgs("en").AdminPricing.preview.title);
    expect(html).not.toContain(msgs("en").AdminPricing.preview.save);
    expect(html).not.toContain('id="rule-reason"');
  });

  it.each(LOCALES)(
    "a good preview shows the five products and then the save form in %s",
    async (locale) => {
      state.pricing = pricing({
        submitted: true,
        preview: { kind: "ok", rows: previewRows },
      });
      const html = inProvider(await PricingPage(params(locale, { go: "1" })), locale);
      const m = msgs(locale).AdminPricing;
      for (const id of SAMPLES) expect(html).toContain(sampleText(locale, id));
      expect(html).toContain(m.preview.save);
      expect(html).toContain('id="rule-reason"');
      // The draft travels in hidden fields of the save form.
      expect(html).toContain('type="hidden" name="code0" value="markup"');
      // Paisa through the kit, never a float: 700.00 taka for 70000 paisa.
      expect(html).toMatch(/৳.?700|৳.?৭০০/);
      // The preview comes before the save button.
      expect(html.indexOf(m.preview.samples.instance_5)).toBeLessThan(html.indexOf(m.preview.save));
    },
  );

  it.each([
    ["invalid", { kind: "invalid", fields: ["steps[0].rate"] }],
    ["unavailable", { kind: "unavailable" }],
  ])("a %s preview offers no save", async (_name, preview) => {
    state.pricing = pricing({ submitted: true, preview });
    const html = inProvider(await PricingPage(params("en", { go: "1" })), "en");
    expect(html).not.toContain(msgs("en").AdminPricing.preview.save);
    expect(html).not.toContain('id="rule-reason"');
    expect(html).toContain('role="alert"');
  });

  it("an unavailable store shows its state and no data", async () => {
    state.pricing = { kind: "unavailable" };
    const html = inProvider(await PricingPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminPricing.unavailable.title);
    expect(html).not.toContain("122.5");
  });

  it("the approve form is for a different admin, never for the requester", async () => {
    const pending = {
      market: "BD",
      rate: "140",
      effectiveFrom: null,
      reason: "r",
      requestedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      status: "pending",
      approvedBy: null,
      approvedAt: null,
    };
    state.pricing = pricing({ pending: { ...pending, requestedBy: OTHER_ID } });
    const other = inProvider(await PricingPage(params("en")), "en");
    expect(other).toContain(msgs("en").AdminPricing.fx.approveSubmit);
    expect(other).toContain("140");
    state.pricing = pricing({ pending: { ...pending, requestedBy: ADMIN_ID } });
    const mine = inProvider(await PricingPage(params("en")), "en");
    expect(mine).not.toContain(msgs("en").AdminPricing.fx.approveSubmit);
    expect(mine).toContain(msgs("en").AdminPricing.fx.mine);
  });

  it.each(LOCALES)(
    "WPU-Y1: shows who set the rate, when and its age, and warns in words once it is older than 6 days (%s)",
    async (locale) => {
      const m = msgs(locale).AdminPricing.fx;
      const meta = { setBy: "0191a000-0000-7000-8000-0000000000ad", setAt: NOW };
      const day = 86_400;
      state.pricing = pricing({ fxMeta: meta, fxState: "fresh", fxAgeSeconds: 2 * day + 3600 });
      const fresh = inProvider(await PricingPage(params(locale)), locale);
      expect(fresh).toContain(m.state.fresh);
      expect(fresh).toContain("0191a000");
      expect(fresh).not.toContain('role="alert"');
      for (const [fxState, age] of [
        ["ageing", 6 * day + 60],
        ["stale", 8 * day],
        ["missing", null],
      ] as const) {
        state.pricing = pricing({ fxMeta: meta, fxState, fxAgeSeconds: age });
        const html = inProvider(await PricingPage(params(locale)), locale);
        expect(html, fxState).toContain(m.state[fxState]);
        expect(html, fxState).toContain('role="alert"');
      }
    },
  );

  it("WPU-Y1: both the request form and the approve form carry the confirm box, and neither names an approver", async () => {
    const pending = {
      market: "BD",
      rate: "140",
      effectiveFrom: null,
      reason: "r",
      requestedBy: OTHER_ID,
      requestedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      status: "pending",
      approvedBy: null,
      approvedAt: null,
    };
    state.pricing = pricing({ pending });
    const html = inProvider(await PricingPage(params("en")), "en");
    expect(html.match(/name="confirmLarge"/g)?.length).toBe(2);
  });

  it("no form carries a field that names an approver", async () => {
    state.pricing = pricing({
      submitted: true,
      preview: { kind: "ok", rows: previewRows },
    });
    const html = inProvider(await PricingPage(params("en", { go: "1" })), "en");
    expect(html).not.toMatch(/name="(requestedBy|approvedBy|approver|secondAdmin)"/);
  });

  it("shows the code of a result and ignores one that is not ours", async () => {
    const known = inProvider(await PricingPage(params("en", { result: "pending" })), "en");
    expect(known).toContain(msgs("en").AdminPricing.result.pending);
    const unknown = inProvider(
      await PricingPage(params("en", { result: "<script>alert(1)</script>" })),
      "en",
    );
    expect(unknown).not.toContain("<script>alert");
  });

  it.each(["support", "ops"])("a %s is refused: the neutral page and no data", async (role) => {
    state.page = { kind: "denied" };
    void role;
    const html = inProvider(await PricingPage(params("en")), "en");
    expect(html).not.toContain("122.5");
    expect(state.pricingQueries).toEqual([]);
  });

  it("a locale that is not ours is a 404", async () => {
    await expect(PricingPage(params("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/catalog", () => {
  it.each(LOCALES)(
    "shows the flags with their dependencies and the products in %s",
    async (locale) => {
      as("ops");
      const html = inProvider(await CatalogPage(params(locale)), locale);
      const m = msgs(locale).AdminCatalog;
      expect(html).toContain(m.flags.title);
      expect(html).toContain(m.flags.names.backup);
      // backup needs linux servers, which are on; domain needs DNS zones, which are off.
      expect(html).toContain(m.flags.missing.replace("{list}", m.flags.names.dns_zone));
      expect(html).not.toContain(m.flags.missing.replace("{list}", m.flags.names.linux_instance));
      expect(html).toContain(m.products.title);
      expect(html).toContain("nano_3_0");
      expect(html).toContain(m.products.noPrice);
      expect(html).toContain(m.products.inactive);
      expect(state.asked).toEqual([[locale, "catalog"]]);
    },
  );

  it("every flag has a switch with a reason field; every family starts as the data says (off stays off)", async () => {
    as("ops");
    const html = inProvider(await CatalogPage(params("en")), "en");
    expect(html.match(/name="turn"/g)?.length).toBe(12);
    expect(html.match(/name="turn" value="on"/g)?.length).toBe(11);
    expect(html.match(/name="turn" value="off"/g)?.length).toBe(1);
    expect(html.match(/name="reason"/g)?.length).toBe(12);
  });

  it("the synced facts and `active` are shown, never editable", async () => {
    as("ops");
    const html = inProvider(await CatalogPage(params("en")), "en");
    expect(html).not.toMatch(/name="(awsPriceUsd|aws_price_usd|active|awsId|region|specs)"/);
    expect(html).toContain(msgs("en").AdminCatalog.products.activeHint);
  });

  it.each(LOCALES)(
    "shows the image allow-list with its switch, the user and the Regions in %s",
    async (locale) => {
      as("ops");
      const html = inProvider(await CatalogPage(params(locale)), locale);
      const m = msgs(locale).AdminCatalog.images;
      expect(html).toContain(m.title);
      expect(html).toContain("WordPress (wordpress)");
      expect(html).toContain("bitnami");
      expect(html).toContain("ap-southeast-1, ap-south-1");
      expect(html).toContain(m.regionsNone);
      expect(html).toContain(m.kindApp);
      expect(html).toContain(m.kindOs);
      expect(html).toContain(m.byDefault);
      expect(html).toContain(m.bySwitch);
    },
  );

  it("each image has its own switch and reason field, apart from the flags", async () => {
    as("ops");
    const html = inProvider(await CatalogPage(params("en")), "en");
    // wordpress is on, so its button turns it off; ubuntu is off, so its button turns it on.
    expect(html).toContain('name="imageTurn" value="off"');
    expect(html).toContain('name="imageTurn" value="on"');
    expect(html.match(/name="imageReason"/g)?.length).toBe(2);
    expect(html).toContain('name="image" value="wordpress"');
    // Nothing synced from AWS is editable here.
    expect(html).not.toMatch(/name="(loginUser|kind|regions|blueprintId)"/);
  });

  it.each(LOCALES)(
    "WPU-G10: each image shows the minimum plan power in force and where it comes from, and has its own form in %s",
    async (locale) => {
      as("ops");
      const html = inProvider(await CatalogPage(params(locale)), locale);
      const m = msgs(locale).AdminCatalog.images;
      expect(html).toContain(m.minPower);
      expect(html).toContain(m.minPowerBy.default);
      expect(html).toContain(m.minPowerBy.admin);
      expect(html).toContain("<strong>1000</strong>");
      expect(html).toContain(m.minPowerSave);
      // one form for each image, with a reason of its own; the admin's value is the default of the field
      expect(html.match(/name="powerReason"/g)?.length).toBe(2);
      expect(html.match(/name="minPower"/g)?.length).toBe(2);
      expect(html).toMatch(/name="minPower"[^>]*value="500"/);
    },
  );

  it("a stored list that cannot be read says so, and no image is shown as on", async () => {
    as("ops");
    const base = catalog();
    state.catalog = {
      ...base,
      value: { ...base.value, imagesInvalid: true, images: [] },
    };
    const html = inProvider(await CatalogPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminCatalog.images.invalid);
    expect(html).toContain(msgs("en").AdminCatalog.images.empty);
  });

  it("a finance admin is refused by the guard in the page's view: the data is never read", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await CatalogPage(params("en")), "en");
    expect(html).not.toContain("nano_3_0");
  });
});

// The cross-check with the mockup: the classes of the rendered screens are the classes the theme pages
// use, and every class is defined by the theme, Bootstrap, Font Awesome or tc.css.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../..", "design/mockup/template");

function classTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const attribute of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}
const mockup = (file: string) => classTokens(readFileSync(resolve(mockupRoot, file), "utf8"));

type Screen = "pricing" | "catalog";
const ANCHORS: { screen: Screen; file: string; classes: string[]; why: string }[] = [
  {
    screen: "pricing",
    file: "cart.html",
    classes: ["table-responsive-lg", "table", "compare", "seccolor", "title", "mergecolor"],
    why: "the history tables are the table of the cart page",
  },
  {
    screen: "pricing",
    file: "elements.html",
    classes: ["cd-filter-block", "cd-filter-content", "form-control"],
    why: "the editor and the rate form are the form block of the elements page",
  },
  {
    screen: "pricing",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each block is the card of the checkout page",
  },
  {
    screen: "catalog",
    file: "cart.html",
    classes: ["table-responsive-lg", "compare"],
    why: "the product and flag tables are the table of the cart page",
  },
  {
    screen: "catalog",
    file: "payments.html",
    classes: ["badge", "bg-purple"],
    why: "the on and active states are badges of the payments page",
  },
  {
    screen: "catalog",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow"],
    why: "each block is the card of the checkout page",
  },
];

describe("the pricing and catalog screens follow the mockup", () => {
  const render = async (screen: Screen, locale: Locale) => {
    if (screen === "pricing") {
      as("finance");
      state.pricing = pricing({ submitted: true, preview: { kind: "ok", rows: previewRows } });
      return inProvider(await PricingPage(params(locale, { go: "1" })), locale);
    }
    as("ops");
    return inProvider(await CatalogPage(params(locale)), locale);
  };

  for (const anchor of ANCHORS) {
    it.skipIf(!mockupPresent())(`${anchor.screen} / ${anchor.file}: ${anchor.why}`, async () => {
      const inMockup = mockup(anchor.file);
      expect(
        anchor.classes.filter((c) => !inMockup.has(c)),
        `not in ${anchor.file}`,
      ).toEqual([]);
      for (const locale of LOCALES) {
        const tokens = classTokens(await render(anchor.screen, locale));
        expect(
          anchor.classes.filter((c) => !tokens.has(c)),
          `${anchor.screen} in ${locale}`,
        ).toEqual([]);
      }
    });
  }

  it.skipIf(!vendoredThemePresent())(
    "every class of both screens is defined by the theme, Bootstrap, Font Awesome or tc.css",
    async () => {
      const known = knownClasses();
      for (const screen of ["pricing", "catalog"] as const) {
        for (const locale of LOCALES) {
          const unknown = [...classTokens(await render(screen, locale))].filter(
            (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
          );
          expect(unknown, `${screen} in ${locale}`).toEqual([]);
        }
      }
    },
  );
});
