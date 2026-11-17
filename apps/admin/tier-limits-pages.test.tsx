import { knownClasses } from "@tc/ui/class-inventory";
import { vendoredThemePresent } from "@tc/ui/theme-present";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { tierLimitsEn } from "./messages/tierlimits.en.ts";
import { tierLimitsBn } from "./messages/tierlimits.ts";

// WPU-G10: the screen /catalog/limits. The page asks the guard first (the catalog section: ops and
// superadmin), the loader gives a fixed state, and every tier has its own form with a reason.
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";

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
vi.mock("./server/pricing-actions.ts", () => ({ saveTierLimitsAction: async () => {} }));
vi.mock("./server/tier-limits-data.ts", () => ({
  loadTierLimits: async (_admin: unknown, raw: unknown) => {
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

const { default: LimitsPage } = await import("./app/[locale]/catalog/limits/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const DEFAULTS = {
  new: { maxInstances: 50, maxBundleUsd: "24", windows: false, containers: false, maxStaticIps: 1 },
  trusted: {
    maxInstances: 200,
    maxBundleUsd: "9999",
    windows: true,
    containers: false,
    maxStaticIps: 1,
  },
};
const audit = (id: string, before: number, after: number, reason: string) => ({
  id,
  createdAt: new Date("2026-11-10T00:00:00Z"),
  actorId: "0191a000-0000-7000-8000-0000000000ae",
  actorType: "admin",
  action: "tier_limits.save",
  targetType: "tier_limits",
  targetId: "BD/new",
  reason,
  before: { maxInstances: before },
  after: { maxInstances: after },
  extra: {},
  ip: null,
  userAgent: null,
});

function screen(lines: Record<string, unknown>[] = []) {
  const base = (["new", "trusted"] as const).map((tier) => ({
    tier,
    source: "default",
    limits: DEFAULTS[tier],
    defaults: DEFAULTS[tier],
    history: [],
  }));
  return {
    kind: "ok",
    value: {
      markets: ["BD", "KE"],
      market: "BD",
      lines: base.map((line, i) => ({ ...line, ...(lines[i] ?? {}) })),
      open: null,
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
const msgs = (locale: Locale): typeof tierLimitsEn =>
  (locale === "bn" ? tierLimitsBn : tierLimitsEn) as typeof tierLimitsEn;

beforeEach(() => {
  state.asked = [];
  state.loaded = 0;
  state.queries = [];
  as("ops");
  state.screen = screen();
});

describe("/catalog/limits", () => {
  it.each(LOCALES)("shows the limits of both tiers with their source in %s", async (locale) => {
    const html = inProvider(await LimitsPage(params(locale)), locale);
    const m = msgs(locale).AdminTierLimits;
    expect(html).toContain(m.title);
    expect(html).toContain(m.tiers.new);
    expect(html).toContain(m.tiers.trusted);
    expect(html).toContain(m.source.default);
    expect(html).toContain("<strong>50</strong>");
    expect(html).toContain("<strong>9999</strong>");
    expect(state.asked).toEqual([[locale, "catalog"]]);
  });

  it("each tier has its own form: counts, a bundle price, two switches, a reason; and no actor travels", async () => {
    const html = inProvider(await LimitsPage(params("en")), "en");
    for (const tier of ["new", "trusted"]) {
      expect(html).toContain(`name="tier" value="${tier}"`);
    }
    expect(html.match(/name="maxInstances"/g)?.length).toBe(2);
    expect(html.match(/name="maxBundleUsd"/g)?.length).toBe(2);
    expect(html.match(/name="maxStaticIps"/g)?.length).toBe(2);
    expect(
      html.match(
        /type="checkbox"[^>]*name="windows"[^>]*value="on"|name="windows"[^>]*type="checkbox"/g,
      )?.length,
    ).toBe(2);
    expect(html.match(/name="reason"/g)?.length).toBe(2);
    // the trusted tier opens with Windows ticked, the new tier without
    expect(html.match(/name="windows"[^>]*checked=""|checked=""[^>]*name="windows"/g)?.length).toBe(
      1,
    );
    expect(html).not.toMatch(/name="(actor|adminId|role|approver)/);
  });

  it("the form opens on the stored limits of a tier", async () => {
    state.screen = screen([
      {
        source: "stored",
        limits: { ...DEFAULTS.new, maxInstances: 7, maxBundleUsd: "40" },
      },
    ]);
    const html = inProvider(await LimitsPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminTierLimits.source.stored);
    expect(html).toContain('value="7"');
    expect(html).toContain('value="40"');
  });

  it.each(LOCALES)(
    "a stored row that cannot be read is said, and the form opens on the defaults in %s",
    async (locale) => {
      state.screen = screen([{ source: "invalid", limits: null }]);
      const html = inProvider(await LimitsPage(params(locale)), locale);
      const m = msgs(locale).AdminTierLimits;
      expect(html).toContain(m.invalid);
      expect(html).toContain(m.source.invalid);
      expect(html).toContain('value="50"');
    },
  );

  it.each(LOCALES)(
    "the history shows who, when, the change and the reason in %s",
    async (locale) => {
      state.screen = screen([{ history: [audit("a1", 50, 80, "pilot customers need more")] }]);
      const html = inProvider(await LimitsPage(params(locale)), locale);
      expect(html).toContain("pilot customers need more");
      expect(html).toContain("#0191a000");
      expect(html).toContain("50 &gt; 80");
    },
  );

  it("a tier without a change says there is no history", async () => {
    const html = inProvider(await LimitsPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminTierLimits.history.empty);
  });

  it("the guard comes first and a refused role reads nothing (R9, R16)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await LimitsPage(params("en")), "en");
    expect(state.loaded).toBe(0);
    expect(html).not.toContain(msgs("en").AdminTierLimits.title);
  });

  it("a locale that is not ours is a 404", async () => {
    await expect(LimitsPage(params("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.asked).toEqual([]);
  });

  it.each(LOCALES)("an unavailable store shows its state and no data in %s", async (locale) => {
    state.screen = { kind: "unavailable" };
    const html = inProvider(await LimitsPage(params(locale)), locale);
    expect(html).toContain(msgs(locale).AdminTierLimits.unavailable.title);
    expect(html).not.toContain("<strong>50</strong>");
  });

  it("shows a result code of ours and ignores one that is not", async () => {
    const ok = inProvider(await LimitsPage(params("en", { result: "invalid" })), "en");
    expect(ok).toContain(msgs("en").AdminTierLimits.result.invalid);
    // (React adds its own form replay script, so the test looks for the text that was sent.)
    const other = inProvider(
      await LimitsPage(params("en", { result: "<script>alert(1)</script>" })),
      "en",
    );
    expect(other).not.toContain("alert(1)");
  });

  it("has no inline style (360px)", async () => {
    state.screen = screen([{ history: [audit("a1", 50, 80, "r")] }]);
    const html = inProvider(await LimitsPage(params("en")), "en");
    expect(html).not.toMatch(/\sstyle\s*=/);
  });

  it.skipIf(!vendoredThemePresent())(
    "every class is defined by the theme, Bootstrap, Font Awesome or tc.css",
    async () => {
      state.screen = screen([{ history: [audit("a1", 50, 80, "r")] }]);
      const html = inProvider(await LimitsPage(params("en")), "en");
      const known = knownClasses();
      const unknown = new Set<string>();
      for (const attribute of html.matchAll(/class="([^"]*)"/g)) {
        for (const token of (attribute[1] ?? "").split(/\s+/)) {
          if (token !== "" && !known.has(token) && token !== "clear" && token !== "tc-skip-link") {
            unknown.add(token);
          }
        }
      }
      expect([...unknown]).toEqual([]);
    },
  );
});
