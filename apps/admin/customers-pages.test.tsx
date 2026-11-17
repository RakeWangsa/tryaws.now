import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { mockupPresent, vendoredThemePresent } from "@tc/ui/theme-present";
import type { CustomerDetail, CustomerListRow, KycQueueRow } from "@tc/db";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { customersBn } from "./messages/customers.ts";
import { customersEn } from "./messages/customers.en.ts";

const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const CUSTOMER_ID = "0191a000-0000-7000-8000-0000000000c1";
const SUBMISSION_ID = "0191a000-0000-7000-8000-0000000000e1";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  list: undefined as unknown,
  searched: [] as unknown[],
  queue: undefined as unknown,
  detail: undefined as unknown,
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
// The loaders are the real ones; only the transaction is replaced by the fake repositories.
vi.mock("./server/runtime.ts", () => ({
  readAsAdmin: async (_actor: unknown, fn: (repos: unknown) => Promise<unknown>) =>
    fn({
      customers: {
        search: async (input: unknown) => {
          state.searched.push(input);
          return state.list;
        },
        kycQueue: async () => state.queue,
        detail: async () => state.detail,
      },
    }),
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

const { default: ListPage } = await import("./app/[locale]/customers/page.tsx");
const { default: DetailPage } = await import("./app/[locale]/customers/[id]/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const CREATED = new Date("2026-11-10T06:00:00.000Z");

const row = (over: Partial<CustomerListRow> = {}): CustomerListRow => ({
  id: CUSTOMER_ID,
  name: "Rahim Uddin",
  emailMasked: "r***@example.test",
  phoneMasked: "+8801*******78",
  kycStatus: "pending",
  riskTier: "new",
  status: "active",
  createdAt: CREATED,
  ...over,
});

const detail = (over: Partial<CustomerDetail> = {}): CustomerDetail => ({
  ...row(),
  type: "individual",
  market: "BD",
  locale: "bn",
  phoneVerified: true,
  wallet: { currency: "BDT", balanceMinor: 123456n },
  resourceCount: 2,
  kycSubmissions: [
    {
      id: SUBMISSION_ID,
      documentType: "nid",
      status: "pending",
      documentCount: 2,
      reviewedAt: null,
      reviewerId: null,
      note: null,
      createdAt: CREATED,
    },
  ],
  audit: [
    {
      id: "a1",
      action: "customer.set_risk_tier",
      actorId: ADMIN_ID,
      reason: "known customer",
      createdAt: CREATED,
    },
  ],
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
  state.page = { kind: "ok", admin: { adminId: ADMIN_ID, role, ip: "203.0.113.5" } };
};
const listParams = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
const detailParams = (locale: string, id = CUSTOMER_ID, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale, id }),
  searchParams: Promise.resolve(search),
});
const msgs = (locale: Locale) =>
  locale === "en" ? customersEn.AdminCustomers : customersBn.AdminCustomers;

beforeEach(() => {
  as("support");
  state.asked = [];
  state.list = { ok: true, value: { rows: [row()], nextAfter: null }, replayed: false };
  state.searched = [];
  state.queue = { ok: true, value: [], replayed: false };
  state.detail = { ok: true, value: detail(), replayed: false };
});

describe("/customers", () => {
  it.each(LOCALES)("lists customers with masked email and phone only (%s)", async (locale) => {
    const html = inProvider(await ListPage(listParams(locale)), locale);
    expect(html).toContain("r***@example.test");
    expect(html).toContain("+8801*******78");
    expect(html).toContain(msgs(locale).table.name);
    expect(html).toContain(`href="/en/customers/${CUSTOMER_ID}"`);
    expect(html).not.toMatch(/@example\.test"?>[^<]*[a-z]{2,}@/);
    expect(html).not.toContain("<script");
  });

  it("asks the guard for the customers area", async () => {
    await ListPage(listParams("en"));
    expect(state.asked).toEqual([["en", "customers"]]);
  });

  it("shows the neutral page and none of the data when the guard refuses (fail closed)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await ListPage(listParams("en")), "en");
    expect(html).not.toContain("Rahim");
    expect(html).not.toContain("tc-ops-label");
  });

  it.each(LOCALES)("shows the queue for ?kyc=pending without words (%s)", async (locale) => {
    const queued: KycQueueRow = {
      submissionId: SUBMISSION_ID,
      customerId: CUSTOMER_ID,
      customerName: "Queued Person",
      documentType: "nid",
      createdAt: CREATED,
    };
    state.queue = { ok: true, value: [queued], replayed: false };
    const html = inProvider(await ListPage(listParams(locale, { kyc: "pending" })), locale);
    expect(html).toContain(msgs(locale).queueTitle);
    expect(html).toContain("Queued Person");
    expect(html).toContain(msgs(locale).table.submitted);
  });

  it("an empty result and an unavailable store show their own states", async () => {
    state.list = { ok: true, value: { rows: [], nextAfter: null }, replayed: false };
    expect(inProvider(await ListPage(listParams("en")), "en")).toContain(msgs("en").empty.title);
    state.list = { ok: false, error: "forbidden" };
    const html = inProvider(await ListPage(listParams("en")), "en");
    expect(html).toContain(msgs("en").unavailable.title);
    expect(html).not.toContain("Rahim");
  });

  it("passes only values of ours to the search and drops the rest", async () => {
    await ListPage(listParams("en", { q: "  Rahim ", kyc: "pending", after: "not-a-uuid" }));
    await ListPage(listParams("en", { kyc: "'; drop table customers;--", after: CUSTOMER_ID }));
    expect(state.searched).toEqual([{ q: "Rahim", kycStatus: "pending" }, { after: CUSTOMER_ID }]);
  });

  it("an unknown locale is a 404", async () => {
    await expect(ListPage(listParams("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/customers/[id]", () => {
  it.each(LOCALES)(
    "support reads: profile, documents, audit, and no decision form (%s)",
    async (locale) => {
      as("support");
      const html = inProvider(await DetailPage(detailParams(locale)), locale);
      expect(html).toContain("Rahim Uddin");
      expect(html).toContain("r***@example.test");
      expect(html).toContain(msgs(locale).detail.readOnly);
      expect(html).toContain(`/api/kyc-document/${SUBMISSION_ID}/0`);
      expect(html).toContain(`/api/kyc-document/${SUBMISSION_ID}/1`);
      expect(html).toContain("customer.set_risk_tier");
      // R10: the only reason field is the one that comes with the document view (one submission).
      expect(html.match(/name="reason"/g)).toHaveLength(1);
      expect(html).toContain(`formAction="/api/kyc-document/${SUBMISSION_ID}/1"`);
      expect(html).not.toContain('value="approveKyc"');
    },
  );

  it.each(["ops", "superadmin"])(
    "%s sees the five decisions as forms with a reason",
    async (role) => {
      as(role);
      const html = inProvider(await DetailPage(detailParams("en")), "en");
      for (const kind of ["approveKyc", "rejectKyc", "setRiskTier", "suspend"]) {
        expect(html).toContain(`name="kind" value="${kind}"`);
      }
      // Four decisions, and the reason of the document view.
      expect(html.match(/name="reason"/g)?.length).toBe(5);
      expect(html).toContain(`name="customerId" value="${CUSTOMER_ID}"`);
      expect(html).toContain(msgs("en").account.suspendHint);
    },
  );

  it("a suspended customer offers resume, not suspend", async () => {
    as("ops");
    state.detail = { ok: true, value: detail({ status: "suspended" }) };
    const html = inProvider(await DetailPage(detailParams("en")), "en");
    expect(html).toContain('name="kind" value="resume"');
    expect(html).not.toContain('name="kind" value="suspend"');
  });

  it("an older submission and a decided one carry no review form", async () => {
    as("ops");
    const base = detail().kycSubmissions[0]!;
    state.detail = {
      ok: true,
      value: detail({
        kycSubmissions: [
          {
            ...base,
            id: "0191a000-0000-7000-8000-0000000000e2",
            status: "verified",
            reviewedAt: CREATED,
          },
          base,
        ],
      }),
      replayed: false,
    };
    const html = inProvider(await DetailPage(detailParams("en")), "en");
    expect(html).not.toContain('value="approveKyc"');
    expect(html).not.toContain('value="rejectKyc"');
    expect(html).toContain(msgs("en").kyc.onlyLatest);
  });

  it("never shows a storage key or a raw email", async () => {
    as("ops");
    const html = inProvider(await DetailPage(detailParams("en")), "en");
    expect(html).not.toMatch(/kyc\/[a-z0-9-]+\/|s3:|amazonaws/i);
  });

  it.each(["ok", "replayed", "conflict", "unavailable"])("shows the result %s", async (result) => {
    as("ops");
    const html = inProvider(await DetailPage(detailParams("en", CUSTOMER_ID, { result })), "en");
    expect(html).toContain(
      msgs("en").result[result as keyof typeof customersEn.AdminCustomers.result],
    );
  });

  it("ignores a result code that is not one of ours", async () => {
    as("ops");
    const html = inProvider(
      await DetailPage(detailParams("en", CUSTOMER_ID, { result: "<script>x</script>" })),
      "en",
    );
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain('role="status"');
  });

  it("a malformed id and a missing customer are 404; an unavailable store shows its state", async () => {
    await expect(DetailPage(detailParams("en", "not-a-uuid"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.detail = { ok: false, error: "not_found" };
    await expect(DetailPage(detailParams("en"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.detail = { ok: false, error: "forbidden" };
    const html = inProvider(await DetailPage(detailParams("en")), "en");
    expect(html).toContain(msgs("en").unavailable.title);
    expect(html).not.toContain("Rahim");
  });

  it("a refusal by the guard shows no data (an admin without the role, fail closed)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await DetailPage(detailParams("en")), "en");
    expect(html).not.toContain("Rahim");
    expect(html).not.toContain("kyc-document");
    expect(state.asked).toEqual([["en", "customers"]]);
  });
});

// The cross-check with the mockup: the classes of the rendered screens are the classes the theme
// pages use, and every class is defined by the theme, Bootstrap, Font Awesome or tc.css.
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

const ANCHORS: { screen: "list" | "detail"; file: string; classes: string[]; why: string }[] = [
  {
    screen: "list",
    file: "cart.html",
    classes: ["table-responsive-lg", "table", "compare", "seccolor", "title", "mergecolor"],
    why: "the result table is the table of the cart page",
  },
  {
    screen: "list",
    file: "elements.html",
    classes: ["cd-filter-block", "cd-filter-content", "form-control"],
    why: "the search form is the form block of the elements page",
  },
  {
    screen: "detail",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each block of the customer page is the card of the checkout page",
  },
  {
    screen: "detail",
    file: "cart.html",
    classes: ["table-responsive-lg", "compare"],
    why: "the audit trail is the table of the cart page",
  },
  {
    screen: "detail",
    file: "payments.html",
    classes: ["badge", "bg-purple"],
    why: "the KYC state is a badge of the payments page",
  },
];

describe("the customer screens follow the mockup", () => {
  const render = async (screen: "list" | "detail", locale: Locale) => {
    as("ops");
    return screen === "list"
      ? inProvider(await ListPage(listParams(locale)), locale)
      : inProvider(await DetailPage(detailParams(locale)), locale);
  };
  const rendered = (html: string) => classTokens(html);

  for (const anchor of ANCHORS) {
    it.skipIf(!mockupPresent())(`${anchor.screen} / ${anchor.file}: ${anchor.why}`, async () => {
      const inMockup = mockup(anchor.file);
      expect(
        anchor.classes.filter((c) => !inMockup.has(c)),
        `not in ${anchor.file}`,
      ).toEqual([]);
      state.detail = { ok: true, value: detail({ kycStatus: "verified" }), replayed: false };
      for (const locale of LOCALES) {
        const tokens = rendered(await render(anchor.screen, locale));
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
      for (const screen of ["list", "detail"] as const) {
        for (const locale of LOCALES) {
          const unknown = [...rendered(await render(screen, locale))].filter(
            (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
          );
          expect(unknown, `${screen} in ${locale}`).toEqual([]);
        }
      }
    },
  );
});
