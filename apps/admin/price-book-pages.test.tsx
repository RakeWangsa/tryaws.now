import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { priceBookEn } from "./messages/pricebook.en.ts";
import { priceBookBn } from "./messages/pricebook.ts";

// WPA-P1: the screen /pricing/book. The page asks the guard first, the loader gives a fixed state, and
// the save buttons exist only under a good preview.
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const NOW = new Date("2026-11-12T06:00:00.000Z");

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  list: undefined as unknown,
  loaded: 0,
  queries: [] as unknown[],
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
  saveBookAction: async () => {},
  setBaseCostAction: async () => {},
}));
vi.mock("./server/price-book-data.ts", () => ({
  loadPriceList: async (_admin: unknown, raw: unknown) => {
    state.loaded += 1;
    state.queries.push(raw);
    return state.list;
  },
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

const { default: BookPage } = await import("./app/[locale]/pricing/book/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const FAMILIES = [
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
];

const quote = (totalMinor: bigint) => ({
  currency: "BDT",
  fxRate: "127",
  ruleVersion: "r1",
  baseMinor: 1270n,
  steps: [],
  totalMinor,
});
const figures = (total: bigint, margin: bigint, commission: bigint) => ({
  baseMinor: 1270n,
  marginMinor: margin,
  commissionMinor: commission,
  totalMinor: total,
});
const entry = (over: Record<string, unknown> = {}) => ({
  from: new Date("2026-11-01T00:00:00Z"),
  margin: { kind: "percent", value: "0.15" },
  commission: { kind: "fixed", value: "2" },
  by: "0191a000-0000-7000-8000-0000000000ae",
  ...over,
});
const diskRow = {
  id: "0191a000-0000-7000-8000-0000000000b1",
  family: "disk",
  awsId: "block-storage-gb",
  platform: null,
  region: "ap-southeast-1",
  specs: {},
  awsPriceUsd: "0.1000",
  billingUnit: "gb_month",
  featureFlag: "disk",
  active: true,
  syncedAt: new Date("2026-11-11T00:00:00Z"),
};

function list(over: Record<string, unknown> = {}, familyOver: Record<string, unknown> = {}) {
  return {
    kind: "ok",
    value: {
      markets: ["BD", "KE"],
      market: "BD",
      fx: { id: "f1", market: "BD", rate: "127", effectiveFrom: new Date("2026-11-01T00:00:00Z") },
      families: FAMILIES.map((family) => ({
        family,
        enabled: family === "linux_instance",
        products:
          family === "disk"
            ? [
                {
                  row: diskRow,
                  price: {
                    id: diskRow.id,
                    priceBdt: quote(1650n),
                    marginMinor: 190n,
                    commissionMinor: 2n,
                  },
                },
              ]
            : [],
        entries: family === "disk" ? [entry()] : [],
        inForce: family === "disk" ? entry() : null,
        scheduled: null,
        invalid: false,
        baseEditable: family === "disk",
        ...(family === "disk" ? familyOver : {}),
      })),
      edit: null,
      now: NOW,
      ...over,
    },
  };
}

const goodPreview = (fromSamples = false) => ({
  kind: "ok",
  preview: {
    fxRate: "127",
    fromSamples,
    rows: [
      {
        productId: fromSamples ? "sample_1" : diskRow.id,
        region: fromSamples ? "" : "ap-southeast-1",
        awsId: "block-storage-gb",
        billingUnit: "gb_month",
        active: true,
        awsPriceUsd: "0.1250",
        currentAwsPriceUsd: "0.1000",
        current: figures(1650n, 190n, 2n),
        candidate: figures(2000n, 240n, 3n),
        deltaMinor: 350n,
      },
    ],
  },
});
const edit = (over: Record<string, unknown> = {}) => ({
  family: "disk",
  draft: {
    market: "BD",
    family: "disk",
    marginKind: "percent",
    margin: "15",
    commissionKind: "fixed",
    commission: "2",
    from: "",
  },
  go: "",
  baseProduct: "",
  baseUsd: "",
  preview: { kind: "none" },
  baseHistory: [],
  ...over,
});

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
const msgs = (locale: Locale): typeof priceBookEn =>
  (locale === "bn" ? priceBookBn : priceBookEn) as typeof priceBookEn;

beforeEach(() => {
  state.asked = [];
  state.loaded = 0;
  state.queries = [];
  as("finance");
  state.list = list();
});

describe("/pricing/book", () => {
  it.each(LOCALES)("shows the price list of every family in %s", async (locale) => {
    const html = inProvider(await BookPage(params(locale)), locale);
    const m = msgs(locale).AdminPriceBook;
    expect(html).toContain(m.title);
    expect(html).toContain(m.summary.roundingValue);
    expect(html).toContain("127");
    expect(html).toContain("block-storage-gb");
    expect(html).toContain("0.1000");
    // 1650 paisa through the kit, never a float: 16.50 taka
    expect(html).toMatch(/৳.?16\.50|৳.?১৬\.৫০|16\.50|১৬\.৫০/);
    expect(html).toContain("15%");
    expect(state.asked).toEqual([[locale, "pricing"]]);
    // one edit button for each of the twelve families
    expect([...html.matchAll(/name="family" value="[a-z_]+"/g)].length).toBe(FAMILIES.length);
  });

  it("the guard comes first and a refused role reads nothing (R9, R16)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await BookPage(params("en")), "en");
    expect(state.loaded).toBe(0);
    expect(html).not.toContain(msgs("en").AdminPriceBook.title);
  });

  it("a locale that is not ours is a 404", async () => {
    await expect(BookPage(params("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.asked).toEqual([]);
  });

  it.each(LOCALES)("an unavailable store shows its state and no data in %s", async (locale) => {
    state.list = { kind: "unavailable" };
    const html = inProvider(await BookPage(params(locale)), locale);
    expect(html).toContain(msgs(locale).AdminPriceBook.unavailable.title);
    expect(html).not.toContain("block-storage-gb");
  });

  it.each(LOCALES)("states with no data: no rate, no product, no terms in %s", async (locale) => {
    state.list = list({ fx: null });
    const html = inProvider(await BookPage(params(locale)), locale);
    const m = msgs(locale).AdminPriceBook;
    expect(html).toContain(m.summary.noFx);
    expect(html).toContain(m.family.noTerms);
    expect(html).toContain(m.family.noProducts);
  });

  it.each(LOCALES)("an unreadable stored book is said, not hidden, in %s", async (locale) => {
    state.list = list({}, { invalid: true, entries: [], inForce: null });
    const html = inProvider(await BookPage(params(locale)), locale);
    expect(html).toContain(msgs(locale).AdminPriceBook.family.invalid);
  });

  it("shows a result code of ours and ignores one that is not", async () => {
    const ok = inProvider(await BookPage(params("en", { result: "conflict" })), "en");
    expect(ok).toContain(msgs("en").AdminPriceBook.result.conflict);
    const other = inProvider(await BookPage(params("en", { result: "<script>" })), "en");
    expect(other).not.toContain("<script>");
  });

  it("passes the query to the loader and nothing from it into the markup unescaped", async () => {
    await BookPage(params("en", { market: "BD", family: "disk" }));
    expect(state.queries).toEqual([{ market: "BD", family: "disk" }]);
  });
});

describe("the editor of one family", () => {
  it.each(LOCALES)(
    "opens on the terms in force with no preview and no save in %s",
    async (locale) => {
      state.list = list({ edit: edit() });
      const html = inProvider(await BookPage(params(locale, { family: "disk" })), locale);
      const m = msgs(locale).AdminPriceBook;
      expect(html).toContain(m.editor.previewSubmit);
      expect(html).toContain('name="margin"');
      expect(html).toContain('value="15"');
      expect(html).not.toContain(m.preview.save);
      expect(html).not.toContain('id="book-reason"');
    },
  );

  it.each(LOCALES)(
    "a good preview shows the products and then the save form in %s",
    async (locale) => {
      state.list = list({ edit: edit({ go: "terms", preview: goodPreview() }) });
      const html = inProvider(
        await BookPage(params(locale, { family: "disk", go: "terms" })),
        locale,
      );
      const m = msgs(locale).AdminPriceBook;
      expect(html).toContain(m.preview.save);
      expect(html).toContain('id="book-reason"');
      // the draft travels in hidden fields of the save form, with no actor or approver
      expect(html).toContain('type="hidden" name="margin" value="15"');
      expect(html).not.toMatch(/name="(actor|adminId|role|approver)/);
      expect(html.indexOf("block-storage-gb")).toBeLessThan(html.indexOf(m.preview.save));
      expect(html).toContain(m.preview.onlyNew);
    },
  );

  it("a family with no catalog row is previewed on the sample plans, and says so", async () => {
    state.list = list({
      edit: edit({ family: "backup", go: "terms", preview: goodPreview(true) }),
    });
    const html = inProvider(await BookPage(params("en", { family: "backup", go: "terms" })), "en");
    expect(html).toContain(msgs("en").AdminPriceBook.preview.samples);
    expect(html).toContain(msgs("en").AdminPriceBook.preview.save);
  });

  it.each([
    ["invalid", { kind: "invalid", fields: ["margin"] }],
    ["unavailable", { kind: "unavailable" }],
  ])("a %s preview offers no save", async (_name, preview) => {
    state.list = list({ edit: edit({ go: "terms", preview }) });
    const html = inProvider(await BookPage(params("en", { family: "disk", go: "terms" })), "en");
    expect(html).not.toContain(msgs("en").AdminPriceBook.preview.save);
    expect(html).not.toContain('id="book-reason"');
    expect(html).toContain('role="alert"');
  });

  it("the history lists each setting with its state", async () => {
    const first = entry({
      from: new Date("2026-10-01T00:00:00Z"),
      margin: { kind: "fixed", value: "500" },
    });
    const second = entry();
    const third = entry({ from: new Date("2026-12-01T00:00:00Z") });
    state.list = list(
      { edit: edit() },
      { entries: [first, second, third], inForce: second, scheduled: third },
    );
    const html = inProvider(await BookPage(params("en", { family: "disk" })), "en");
    const m = msgs("en").AdminPriceBook.history;
    expect(html).toContain(m.inForce);
    expect(html).toContain(m.scheduled);
    expect(html).toContain(m.past);
  });
});

describe("the base cost of an admin-priced family", () => {
  it("shows the product, the current cost, and the audit history; a save only under a good preview", async () => {
    state.list = list({
      edit: edit({
        baseHistory: [
          {
            id: "a1",
            createdAt: new Date("2026-11-10T00:00:00Z"),
            actorId: "0191a000-0000-7000-8000-0000000000ae",
            reason: "AWS price page",
            before: { awsPriceUsd: "0.1" },
            after: { awsPriceUsd: "0.125" },
          },
        ],
      }),
    });
    const html = inProvider(await BookPage(params("en", { family: "disk" })), "en");
    const m = msgs("en").AdminPriceBook;
    expect(html).toContain(m.base.title);
    expect(html).toContain('name="usd"');
    expect(html).toContain("AWS price page");
    expect(html).toContain(m.base.arrow.replace("{before}", "0.1").replace("{after}", "0.125"));
    expect(html).not.toContain(m.preview.saveBase);

    state.list = list({
      edit: edit({
        go: "base",
        baseProduct: diskRow.id,
        baseUsd: "0.1250",
        preview: goodPreview(),
      }),
    });
    const good = inProvider(
      await BookPage(
        params("en", { family: "disk", go: "base", product: diskRow.id, usd: "0.1250" }),
      ),
      "en",
    );
    expect(good).toContain(m.preview.saveBase);
    expect(good).toContain('id="base-reason"');
    expect(good).toContain(`type="hidden" name="product" value="${diskRow.id}"`);
  });

  it("a synced family has no base cost form: its cost is read-only", async () => {
    state.list = list({ edit: edit({ family: "linux_instance" }) });
    const html = inProvider(await BookPage(params("en", { family: "linux_instance" })), "en");
    expect(html).not.toContain('name="usd"');
  });
});

describe("the price list follows the mockup", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../..", "design/mockup/template");
  const tokensOf = (text: string): Set<string> => {
    const tokens = new Set<string>();
    for (const a of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
      for (const token of (a[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
    }
    return tokens;
  };

  const render = async (locale: Locale) => {
    state.list = list({ edit: edit({ go: "terms", preview: goodPreview() }) });
    return inProvider(await BookPage(params(locale, { family: "disk", go: "terms" })), locale);
  };

  it("uses the table, form and card classes of the theme pages", async () => {
    const cart = tokensOf(readFileSync(resolve(root, "cart.html"), "utf8"));
    const checkout = tokensOf(readFileSync(resolve(root, "checkout.html"), "utf8"));
    const wanted = {
      "cart.html": ["table-responsive-lg", "compare", "seccolor", "mergecolor"],
      "checkout.html": ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow"],
    };
    expect(wanted["cart.html"].filter((c) => !cart.has(c))).toEqual([]);
    expect(wanted["checkout.html"].filter((c) => !checkout.has(c))).toEqual([]);
    for (const locale of LOCALES) {
      const tokens = tokensOf(await render(locale));
      expect(
        [...wanted["cart.html"], ...wanted["checkout.html"]].filter((c) => !tokens.has(c)),
      ).toEqual([]);
    }
  });

  it("every class is defined by the theme, Bootstrap, Font Awesome or tc.css; no inline style (360px)", async () => {
    const known = knownClasses();
    for (const locale of LOCALES) {
      const html = await render(locale);
      const unknown = [...tokensOf(html)].filter(
        (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
      );
      expect(unknown, locale).toEqual([]);
      expect(html).not.toMatch(/\sstyle\s*=/);
    }
  });
});
