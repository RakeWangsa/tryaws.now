import { knownClasses } from "@tc/ui/class-inventory";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { invoiceSellerEn } from "./messages/invoiceseller.en.ts";
import { invoiceSellerBn } from "./messages/invoiceseller.ts";

// WPU-I1: the screen /pricing/seller. The page asks the guard first, the loader gives a fixed state, the
// form is empty when nothing is saved (nothing is prefilled), and a missing or unreadable row says that no
// invoice is issued. States: loading (the route's loading.tsx), missing, invalid, ready, unavailable.
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const NOW = new Date("2026-11-12T06:00:00.000Z");

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  screen: undefined as unknown,
  loaded: 0,
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
vi.mock("./server/pricing-actions.ts", () => ({ saveInvoiceSellerAction: async () => {} }));
vi.mock("./server/invoice-seller-data.ts", () => ({
  loadInvoiceSeller: async () => {
    state.loaded += 1;
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

const { default: SellerPage } = await import("./app/[locale]/pricing/seller/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const SELLER = {
  legalNameBn: "পরীক্ষা লিমিটেড",
  legalNameEn: "Test Limited",
  bin: "0000000000000",
  addressBn: "ঢাকা",
  addressEn: "Dhaka",
  signatoryName: "Test Signatory",
  signatoryDesignation: "Director",
};
const screen = (over: Record<string, unknown> = {}) => ({
  kind: "ok",
  value: {
    markets: ["BD"],
    market: "BD",
    state: "ready",
    seller: SELLER,
    version: 2,
    backlog: { count: 0, oldest: null },
    history: [
      {
        row: {
          id: "a1",
          createdAt: NOW,
          actorId: ADMIN_ID,
          reason: "moved office",
        },
        changed: ["addressEn"],
      },
    ],
    ...over,
  },
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
const msgs = (locale: Locale): typeof invoiceSellerEn =>
  (locale === "bn" ? invoiceSellerBn : invoiceSellerEn) as typeof invoiceSellerEn;

beforeEach(() => {
  state.asked = [];
  state.loaded = 0;
  as("finance");
  state.screen = screen();
});

describe("/pricing/seller", () => {
  it.each(LOCALES)("shows the saved details, the version and the history in %s", async (locale) => {
    const html = await (async () => inProvider(await SellerPage(params(locale)), locale))();
    const m = msgs(locale).AdminInvoiceSeller;
    expect(html).toContain(m.title);
    expect(html).toContain("0000000000000");
    expect(html).toContain("Test Limited");
    expect(html).toContain("addressEn");
    expect(html).toContain("moved office");
    expect(html).toContain(m.status.ready);
    expect(html).not.toContain(m.notice.missing);
    expect(state.asked).toEqual([[locale, "pricing"]]);
    for (const name of ["legalNameBn", "legalNameEn", "bin", "addressBn", "addressEn", "reason"]) {
      expect(html).toContain(`name="${name}"`);
    }
  });

  it.each(LOCALES)(
    "missing: an empty form and a notice that no invoice is issued in %s",
    async (locale) => {
      state.screen = screen({ state: "missing", seller: null, version: null, history: [] });
      const html = inProvider(await SellerPage(params(locale)), locale);
      const m = msgs(locale).AdminInvoiceSeller;
      expect(html).toContain(m.notice.missing);
      expect(html).toContain(m.history.empty);
      // nothing is prefilled
      expect(html).not.toMatch(/name="bin"[^>]*value="[^"]/);
    },
  );

  it.each(LOCALES)(
    "WPU-I2: the invoices that wait for the seller details are counted in %s",
    async (locale) => {
      state.screen = screen({
        state: "missing",
        seller: null,
        version: null,
        history: [],
        backlog: { count: 7, oldest: NOW },
      });
      const html = inProvider(await SellerPage(params(locale)), locale);
      const m = msgs(locale).AdminInvoiceSeller;
      expect(html).toContain(m.backlog.waiting.replace("{count}", "7"));
      expect(html).toContain(m.backlog.since);
      // nothing waits: no line at all
      state.screen = screen();
      const quiet = inProvider(await SellerPage(params(locale)), locale);
      expect(quiet).not.toContain(m.backlog.since);
    },
  );

  it("invalid: the unreadable notice", async () => {
    state.screen = screen({ state: "invalid", seller: null, version: null });
    const html = inProvider(await SellerPage(params("en")), "en");
    expect(html).toContain(invoiceSellerEn.AdminInvoiceSeller.notice.invalid);
  });

  it("unavailable: the state and no data", async () => {
    state.screen = { kind: "unavailable" };
    const html = inProvider(await SellerPage(params("en")), "en");
    expect(html).toContain(invoiceSellerEn.AdminInvoiceSeller.unavailable.title);
    expect(html).not.toContain("0000000000000");
  });

  it("the guard comes first and a refused role reads nothing (R9, R16)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await SellerPage(params("en")), "en");
    expect(state.loaded).toBe(0);
    expect(html).not.toContain(invoiceSellerEn.AdminInvoiceSeller.title);
  });

  it("a locale that is not ours is a 404", async () => {
    await expect(SellerPage(params("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.asked).toEqual([]);
  });

  it.each(LOCALES)("uses only classes of the mockup theme in %s", async (locale) => {
    for (const s of [screen(), screen({ state: "missing", seller: null, history: [] })]) {
      state.screen = s;
      const html = inProvider(await SellerPage(params(locale)), locale);
      const known = knownClasses();
      const used = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/));
      // `clear` and `tc-skip-link` are the menu and the skip link of the frame, not of this screen.
      const unknown = used.filter(
        (c) => c !== "" && !known.has(c) && c !== "clear" && c !== "tc-skip-link",
      );
      expect(unknown).toEqual([]);
      expect(html).not.toMatch(/\sstyle=/);
    }
  });

  it("shows the result banner for a known code and ignores an unknown one", async () => {
    const ok = inProvider(await SellerPage(params("en", { result: "ok" })), "en");
    expect(ok).toContain(invoiceSellerEn.AdminInvoiceSeller.result.ok);
    const odd = inProvider(await SellerPage(params("en", { result: "<script>" })), "en");
    expect(odd).not.toContain(invoiceSellerEn.AdminInvoiceSeller.result.invalid);
    expect(odd).not.toContain("&lt;script&gt;");
  });
});
