import { knownClasses } from "@tc/ui/class-inventory";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { configPriceEn } from "./messages/configprice.en.ts";
import { configPriceBn } from "./messages/configprice.ts";

// WPU-G10: the screen /pricing/config. The page asks the guard first, the loader gives a fixed state, and
// the save form exists only under a good preview. Four states: loading is the route's loading.tsx, empty
// (no price set), unavailable and invalid are shown here, and the good state with history.
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const NOW = new Date("2026-11-12T06:00:00.000Z");

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  screen: undefined as unknown,
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
vi.mock("./server/pricing-actions.ts", () => ({ saveConfigPriceAction: async () => {} }));
vi.mock("./server/config-price-data.ts", () => ({
  loadConfigPrices: async (_admin: unknown, raw: unknown) => {
    state.loaded += 1;
    state.queries.push(raw);
    return state.screen;
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

const { default: ConfigPage } = await import("./app/[locale]/pricing/config/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const KEYS = [
  "config_price.block_storage_gb_month",
  "config_price.snapshot_gb_month",
  "config_price.load_balancer_month",
  "config_price.dns_zone_month",
] as const;
const UNIT = {
  "config_price.block_storage_gb_month": "gb_month",
  "config_price.snapshot_gb_month": "gb_month",
} as Record<string, string>;
const BY = "0191a000-0000-7000-8000-0000000000ae";
const entry = (usd: string, from = "2026-11-01T00:00:00Z", by: string | null = BY) => ({
  from: new Date(from),
  usd,
  by,
});
const figures = (total: bigint) => ({
  baseMinor: 6350n,
  marginMinor: 100n,
  commissionMinor: 10n,
  totalMinor: total,
});

function screen(over: Record<string, unknown> = {}, lineOver: Record<string, unknown> = {}) {
  return {
    kind: "ok",
    value: {
      markets: ["BD", "KE"],
      market: "BD",
      fx: { id: "f1", market: "BD", rate: "127", effectiveFrom: new Date("2026-11-01T00:00:00Z") },
      lines: KEYS.map((key) => ({
        key,
        unit: UNIT[key] ?? "month",
        family: "x",
        entries:
          key === "config_price.dns_zone_month"
            ? [entry("0.50"), entry("0.60", "2026-12-01T00:00:00Z")]
            : [],
        inForce: key === "config_price.dns_zone_month" ? entry("0.50") : null,
        scheduled:
          key === "config_price.dns_zone_month" ? entry("0.60", "2026-12-01T00:00:00Z") : null,
        invalid: false,
        customerPrice: key === "config_price.dns_zone_month" ? figures(7400n) : null,
        readByOrders: key === "config_price.dns_zone_month",
        ...(key === "config_price.dns_zone_month" ? lineOver : {}),
      })),
      edit: null,
      now: NOW,
      ...over,
    },
  };
}
const edit = (over: Record<string, unknown> = {}) => ({
  key: "config_price.dns_zone_month",
  usd: "0.50",
  from: "",
  go: false,
  preview: { kind: "none" },
  history: [],
  ...over,
});
const good = {
  kind: "ok",
  preview: { fxRate: "127", current: figures(7400n), candidate: figures(8800n), deltaMinor: 1400n },
};

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
const msgs = (locale: Locale): typeof configPriceEn =>
  (locale === "bn" ? configPriceBn : configPriceEn) as typeof configPriceEn;

beforeEach(() => {
  state.asked = [];
  state.loaded = 0;
  state.queries = [];
  as("finance");
  state.screen = screen();
});

describe("/pricing/config", () => {
  it.each(LOCALES)(
    "lists the four prices with the price in force and the next change in %s",
    async (locale) => {
      const html = inProvider(await ConfigPage(params(locale)), locale);
      const m = msgs(locale).AdminConfigPrices;
      expect(html).toContain(m.title);
      for (const name of Object.values(m.names)) expect(html).toContain(name);
      expect(html).toContain("0.50");
      expect(html).toContain("0.60");
      // 7400 paisa through the kit, never a float: 74.00 taka
      expect(html).toMatch(/74\.00|৭৪\.০০/);
      expect(html).toContain(m.state.readNow);
      expect(html).toContain(m.state.notReadYet);
      expect(html).toContain(m.state.none);
      expect(state.asked).toEqual([[locale, "pricing"]]);
      // one edit button for each of the four prices
      expect([...html.matchAll(/name="key" value="config_price\.[a-z_]+"/g)].length).toBe(4);
    },
  );

  it("the guard comes first and a refused role reads nothing (R9, R16)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await ConfigPage(params("en")), "en");
    expect(state.loaded).toBe(0);
    expect(html).not.toContain(msgs("en").AdminConfigPrices.title);
  });

  it("a locale that is not ours is a 404", async () => {
    await expect(ConfigPage(params("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.asked).toEqual([]);
  });

  it.each(LOCALES)("an unavailable store shows its state and no data in %s", async (locale) => {
    state.screen = { kind: "unavailable" };
    const html = inProvider(await ConfigPage(params(locale)), locale);
    expect(html).toContain(msgs(locale).AdminConfigPrices.unavailable.title);
    expect(html).not.toContain("0.50");
  });

  it.each(LOCALES)(
    "no rate in force and an unreadable stored price are said, not hidden, in %s",
    async (locale) => {
      state.screen = screen(
        { fx: null },
        { invalid: true, inForce: null, entries: [], scheduled: null, customerPrice: null },
      );
      const html = inProvider(await ConfigPage(params(locale)), locale);
      const m = msgs(locale).AdminConfigPrices;
      expect(html).toContain(m.summary.noFx);
      expect(html).toContain(m.state.invalid);
    },
  );

  it("shows a result code of ours and ignores one that is not", async () => {
    const ok = inProvider(await ConfigPage(params("en", { result: "conflict" })), "en");
    expect(ok).toContain(msgs("en").AdminConfigPrices.result.conflict);
    const other = inProvider(await ConfigPage(params("en", { result: "<script>" })), "en");
    expect(other).not.toContain("<script>");
  });

  it("passes the query to the loader", async () => {
    await ConfigPage(params("en", { market: "BD", key: "config_price.dns_zone_month" }));
    expect(state.queries).toEqual([{ market: "BD", key: "config_price.dns_zone_month" }]);
  });
});

describe("the editor of one price", () => {
  it.each(LOCALES)(
    "opens on the price in force with no preview and no save in %s",
    async (locale) => {
      state.screen = screen({ edit: edit() });
      const html = inProvider(
        await ConfigPage(params(locale, { key: "config_price.dns_zone_month" })),
        locale,
      );
      const m = msgs(locale).AdminConfigPrices;
      expect(html).toContain(m.editor.previewSubmit);
      expect(html).toContain('name="usd"');
      expect(html).toContain('value="0.50"');
      expect(html).not.toContain(m.preview.save);
      expect(html).not.toContain('id="config-reason"');
    },
  );

  it.each(LOCALES)(
    "a good preview shows the figures and then the save form with a reason in %s",
    async (locale) => {
      state.screen = screen({ edit: edit({ go: true, usd: "0.60", preview: good }) });
      const html = inProvider(
        await ConfigPage(params(locale, { key: "config_price.dns_zone_month", go: "preview" })),
        locale,
      );
      const m = msgs(locale).AdminConfigPrices;
      expect(html).toContain(m.preview.save);
      expect(html).toContain('id="config-reason"');
      expect(html).toContain('type="hidden" name="usd" value="0.60"');
      // no actor, role or approver travels in the form
      expect(html).not.toMatch(/name="(actor|adminId|role|approver)/);
      expect(html).toContain(m.preview.onlyNew);
      expect(html).toMatch(/88\.00|৮৮\.০০/);
    },
  );

  it.each(LOCALES)(
    "a bad draft or an unavailable engine gives no save button in %s",
    async (locale) => {
      const m = msgs(locale).AdminConfigPrices;
      state.screen = screen({
        edit: edit({ go: true, preview: { kind: "invalid", fields: ["usd"] } }),
      });
      let html = inProvider(
        await ConfigPage(params(locale, { key: "config_price.dns_zone_month", go: "preview" })),
        locale,
      );
      expect(html).not.toContain(m.preview.save);
      expect(html).toContain("usd");
      state.screen = screen({ edit: edit({ go: true, preview: { kind: "unavailable" } }) });
      html = inProvider(
        await ConfigPage(params(locale, { key: "config_price.dns_zone_month", go: "preview" })),
        locale,
      );
      expect(html).not.toContain(m.preview.save);
      expect(html).toContain(m.preview.unavailable);
    },
  );

  it.each(LOCALES)(
    "shows the history with the state of each entry and the reason of each change in %s",
    async (locale) => {
      state.screen = screen({
        edit: edit({
          history: [
            {
              id: "a1",
              createdAt: new Date("2026-11-01T00:00:00Z"),
              actorId: BY,
              actorType: "admin",
              action: "config_price.save",
              targetType: "config_price",
              targetId: "BD/config_price.dns_zone_month@2026-11-01T00:00:00.000Z",
              reason: "AWS pricing page of 1 November",
              before: null,
              after: null,
              extra: {},
              ip: null,
              userAgent: null,
            },
          ],
        }),
      });
      const html = inProvider(
        await ConfigPage(params(locale, { key: "config_price.dns_zone_month" })),
        locale,
      );
      const m = msgs(locale).AdminConfigPrices.history;
      expect(html).toContain(m.inForce);
      expect(html).toContain(m.scheduled);
      expect(html).toContain("AWS pricing page of 1 November");
      expect(html).toContain("#0191a000");
    },
  );

  it("a price with no entries says that there is no history", async () => {
    state.screen = screen({ edit: edit({ key: "config_price.load_balancer_month", usd: "" }) });
    const html = inProvider(
      await ConfigPage(params("en", { key: "config_price.load_balancer_month" })),
      "en",
    );
    expect(html).toContain(msgs("en").AdminConfigPrices.history.empty);
  });
});

describe("the markup uses only the classes of the theme (mockup classes only)", () => {
  it("every class of the screen is defined by the theme, Bootstrap, Font Awesome or tc.css", async () => {
    state.screen = screen({ edit: edit({ go: true, usd: "0.60", preview: good }) });
    const html = inProvider(
      await ConfigPage(params("en", { key: "config_price.dns_zone_month", go: "preview" })),
      "en",
    );
    const known = knownClasses();
    const unknown = new Set<string>();
    for (const attribute of html.matchAll(/class="([^"]*)"/g)) {
      for (const token of (attribute[1] ?? "").split(/\s+/)) {
        // `clear` and `tc-skip-link` are the menu and the skip link of the frame, not of this screen.
        if (token !== "" && !known.has(token) && token !== "clear" && token !== "tc-skip-link") {
          unknown.add(token);
        }
      }
    }
    expect([...unknown]).toEqual([]);
    expect(html).not.toContain(" style=");
  });
});
