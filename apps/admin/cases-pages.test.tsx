import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import type {
  AbuseCaseDetail,
  AbuseCaseRow,
  ReconciliationRow,
  SupportRequestDetail,
  SupportRequestRow,
} from "@tc/db";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { casesBn } from "./messages/cases.ts";
import { casesEn } from "./messages/cases.en.ts";

const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const CUSTOMER_ID = "0191a000-0000-7000-8000-0000000000c1";
const REQUEST_ID = "0191a000-0000-7000-8000-0000000000e1";
const CASE_ID = "0191a000-0000-7000-8000-0000000000e2";
const RESOURCE_ID = "0191a000-0000-7000-8000-0000000000e3";
const DISCREPANCY_ID = "0191a000-0000-7000-8000-0000000000e4";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  repos: {} as Record<string, Record<string, unknown>>,
  replyEnabled: false,
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
vi.mock("./server/case-actions.ts", () => ({
  supportAction: async () => {},
  abuseAction: async () => {},
  reconciliationAction: async () => {},
}));
vi.mock("./server/support-reply.ts", () => ({
  get SUPPORT_REPLY_ENABLED() {
    return state.replyEnabled;
  },
}));
// The loaders are the real ones; only the transaction is replaced by the fake repositories.
vi.mock("./server/runtime.ts", () => ({
  readAsAdmin: async (_actor: unknown, fn: (repos: unknown) => Promise<unknown>) => fn(state.repos),
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

const { default: SupportList } = await import("./app/[locale]/support/page.tsx");
const { default: SupportDetail } = await import("./app/[locale]/support/[id]/page.tsx");
const { default: AbuseList } = await import("./app/[locale]/abuse/page.tsx");
const { default: AbuseDetail } = await import("./app/[locale]/abuse/[id]/page.tsx");
const { default: Reconciliation } = await import("./app/[locale]/reconciliation/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const CREATED = new Date("2026-11-10T06:00:00.000Z");
const ok = (value: unknown) => ({ ok: true, value, replayed: false });

const requestRow = (over: Partial<SupportRequestRow> = {}): SupportRequestRow => ({
  id: REQUEST_ID,
  customerId: CUSTOMER_ID,
  name: "Rahim Uddin",
  emailMasked: "r***@example.test",
  category: "billing",
  subject: "Charged twice",
  status: "open",
  relatedResourceId: null,
  handledBy: null,
  createdAt: CREATED,
  ...over,
});
const requestDetail = (over: Partial<SupportRequestDetail> = {}): SupportRequestDetail => ({
  ...requestRow(),
  message: "Please <b>refund</b> me",
  audit: [
    { id: "a1", action: "support.close", actorId: ADMIN_ID, reason: "solved", createdAt: CREATED },
  ],
  ...over,
});
const caseRow = (over: Partial<AbuseCaseRow> = {}): AbuseCaseRow => ({
  id: CASE_ID,
  resourceId: RESOURCE_ID,
  customerId: CUSTOMER_ID,
  customerName: "Rahim Uddin",
  family: "linux_instance",
  region: "ap-southeast-1",
  resourceState: "active",
  source: "third_party_report",
  status: "open",
  notes: "[n1] 2026-11-10 0191a000: called\n[n2] 2026-11-11 0191a000: <script>x</script>",
  createdAt: CREATED,
  ...over,
});
const caseDetail = (over: Partial<AbuseCaseDetail> = {}): AbuseCaseDetail => ({
  ...caseRow(),
  audit: [
    { id: "a1", action: "abuse.open", actorId: ADMIN_ID, reason: "notice", createdAt: CREATED },
  ],
  ...over,
});
const discrepancy = (over: Partial<ReconciliationRow> = {}): ReconciliationRow => ({
  id: DISCREPANCY_ID,
  kind: "orphan",
  status: "open",
  createdAt: CREATED,
  details: [
    { key: "resourceId", value: RESOURCE_ID },
    { key: "region", value: "ap-southeast-1" },
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
const list = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
const one = (locale: string, id: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale, id }),
  searchParams: Promise.resolve(search),
});
const msgs = (locale: Locale) => (locale === "en" ? casesEn.AdminCases : casesBn.AdminCases);

let seen: Record<string, unknown[]> = {};
beforeEach(() => {
  as("support");
  state.asked = [];
  state.replyEnabled = true;
  seen = { supportList: [], abuseList: [], reconList: [] };
  state.repos = {
    support: {
      list: async (input: unknown) => {
        seen["supportList"]?.push(input);
        return ok({ rows: [requestRow()], nextAfter: null });
      },
      detail: async () => ok(requestDetail()),
    },
    abuse: {
      list: async (input: unknown) => {
        seen["abuseList"]?.push(input);
        return ok({ rows: [caseRow()], nextAfter: null });
      },
      detail: async () => ok(caseDetail()),
    },
    reconciliation: {
      overview: async () => ok({ orphan: 3, missing: 0, cost: 1, payment: 2 }),
      list: async (input: unknown) => {
        seen["reconList"]?.push(input);
        return ok({ rows: [discrepancy()], nextAfter: null });
      },
    },
  };
});

describe("/support", () => {
  it.each(LOCALES)(
    "lists requests with a masked address and a link to each (%s)",
    async (locale) => {
      const html = inProvider(await SupportList(list(locale)), locale);
      expect(html).toContain("r***@example.test");
      expect(html).toContain("Charged twice");
      expect(html).toContain(msgs(locale).support.table.subject);
      expect(html).toContain(`href="${locale === "en" ? "/en" : ""}/support/${REQUEST_ID}"`);
      expect(html).not.toContain("<script");
      expect(state.asked).toEqual([[locale, "support"]]);
      expect(seen["supportList"]).toEqual([{ status: "open" }]);
    },
  );

  it("passes only the filters of ours to the repository", async () => {
    await SupportList(list("en", { status: "closed", after: "x", evil: "1" }));
    await SupportList(list("en", { status: "all", after: CASE_ID }));
    expect(seen["supportList"]).toEqual([{ status: "closed" }, { after: CASE_ID }]);
  });

  it("an empty queue and an unavailable store show their own states, with no data", async () => {
    state.repos["support"] = { list: async () => ok({ rows: [], nextAfter: null }) };
    expect(inProvider(await SupportList(list("en")), "en")).toContain(
      msgs("en").support.empty.title,
    );
    state.repos["support"] = { list: async () => ({ ok: false, error: "forbidden" }) };
    const html = inProvider(await SupportList(list("en")), "en");
    expect(html).toContain(msgs("en").unavailable.title);
    expect(html).not.toContain("Charged");
  });

  it("shows the neutral page and none of the data when the guard refuses (fail closed)", async () => {
    state.page = { kind: "denied" };
    for (const html of [
      inProvider(await SupportList(list("en")), "en"),
      inProvider(await SupportDetail(one("en", REQUEST_ID)), "en"),
    ]) {
      expect(html).not.toContain("Charged");
      expect(html).not.toContain("refund");
    }
  });

  it.each(LOCALES)(
    "the detail escapes the customer's text and offers reply and close (%s)",
    async (locale) => {
      const html = inProvider(await SupportDetail(one(locale, REQUEST_ID)), locale);
      expect(html).toContain("Please &lt;b&gt;refund&lt;/b&gt; me");
      expect(html).not.toContain("<b>refund");
      expect(html).toContain('name="kind" value="replyByEmail"');
      expect(html).toContain('name="kind" value="closeRequest"');
      expect(html).toContain('name="replyId"');
      expect(html).toContain(msgs(locale).support.detail.trail);
      // No form field names the acting admin.
      expect(html).not.toMatch(/name="(adminId|actor|approver|handledBy)"/);
    },
  );

  it("while the template is not registered the reply form is replaced by a hint; a closed request has none", async () => {
    state.replyEnabled = false;
    let html = inProvider(await SupportDetail(one("en", REQUEST_ID)), "en");
    expect(html).not.toContain('value="replyByEmail"');
    expect(html).toContain(msgs("en").support.reply.disabled);
    state.replyEnabled = true;
    state.repos["support"] = {
      detail: async () => ok(requestDetail({ status: "closed" })),
    };
    html = inProvider(await SupportDetail(one("en", REQUEST_ID)), "en");
    expect(html).not.toContain('value="replyByEmail"');
    expect(html).not.toContain('value="closeRequest"');
  });

  it("a malformed id and a missing request are 404; an unavailable store shows its state", async () => {
    await expect(SupportDetail(one("en", "x"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.repos["support"] = { detail: async () => ({ ok: false, error: "not_found" }) };
    await expect(SupportDetail(one("en", REQUEST_ID))).rejects.toThrow("NEXT_NOT_FOUND");
    state.repos["support"] = { detail: async () => ({ ok: false, error: "forbidden" }) };
    expect(inProvider(await SupportDetail(one("en", REQUEST_ID)), "en")).toContain(
      msgs("en").unavailable.title,
    );
  });

  it("shows the result of the last action from the URL, only for a known code", async () => {
    let html = inProvider(await SupportDetail(one("en", REQUEST_ID, { result: "replayed" })), "en");
    expect(html).toContain(msgs("en").result.replayed);
    html = inProvider(await SupportDetail(one("en", REQUEST_ID, { result: "<b>x</b>" })), "en");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain('role="status"');
  });
});

describe("/abuse", () => {
  it.each(LOCALES)(
    "lists cases and the form that opens one with a case id (%s)",
    async (locale) => {
      as("ops");
      const html = inProvider(await AbuseList(list(locale)), locale);
      expect(html).toContain(`href="${locale === "en" ? "/en" : ""}/abuse/${CASE_ID}"`);
      expect(html).toContain('name="kind" value="openAbuseCase"');
      expect(html).toMatch(/name="id" value="[0-9a-f-]{36}"/);
      expect(html).toContain(msgs(locale).abuse.table.source);
      expect(state.asked).toEqual([[locale, "abuse"]]);
    },
  );

  it("support and ops both open the screen; the guard is asked for the abuse area", async () => {
    as("support");
    expect(inProvider(await AbuseList(list("en")), "en")).toContain(msgs("en").abuse.title);
  });

  it.each(LOCALES)(
    "the detail shows notes escaped, a link to the customer and the suspension for ops (%s)",
    async (locale) => {
      as("ops");
      const html = inProvider(await AbuseDetail(one(locale, CASE_ID)), locale);
      expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
      expect(html).not.toContain("<script>x");
      expect(html).toContain(`/customers/${CUSTOMER_ID}`);
      expect(html).toContain('name="kind" value="suspendResource"');
      expect(html).toContain('name="kind" value="addNote"');
      expect(html).toContain('name="kind" value="closeAbuseCase"');
      expect(html).toContain('name="noteId"');
    },
  );

  it("support sees the case and the notes but not the suspend form", async () => {
    as("support");
    const html = inProvider(await AbuseDetail(one("en", CASE_ID)), "en");
    expect(html).not.toContain('value="suspendResource"');
    expect(html).toContain(msgs("en").abuse.suspend.onlyOps);
    expect(html).toContain('value="addNote"');
  });

  it("a closed case has no action forms; names no AWS account id, ARN or raw error", async () => {
    as("ops");
    state.repos["abuse"] = { detail: async () => ok(caseDetail({ status: "closed" })) };
    const html = inProvider(await AbuseDetail(one("en", CASE_ID)), "en");
    expect(html).not.toMatch(/name="kind" value="(suspendResource|addNote|closeAbuseCase)"/);
    expect(html).not.toMatch(/arn:aws|\b\d{12}\b|AccessDenied|Exception/);
  });

  it("a suspended resource shows the restore form to ops (also on a closed case) and not to support", async () => {
    state.repos["abuse"] = {
      detail: async () => ok(caseDetail({ status: "closed", resourceState: "suspended" })),
    };
    as("ops");
    const html = inProvider(await AbuseDetail(one("en", CASE_ID)), "en");
    expect(html).toContain('name="kind" value="restoreResource"');
    expect(html).toContain(msgs("en").abuse.restore.title);
    as("support");
    const other = inProvider(await AbuseDetail(one("en", CASE_ID)), "en");
    expect(other).not.toContain('value="restoreResource"');
  });

  it("a refusal by the guard, a bad id and a missing case show no data", async () => {
    state.page = { kind: "denied" };
    expect(inProvider(await AbuseDetail(one("en", CASE_ID)), "en")).not.toContain("linux_instance");
    as("ops");
    await expect(AbuseDetail(one("en", "x"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.repos["abuse"] = { detail: async () => ({ ok: false, error: "not_found" }) };
    await expect(AbuseDetail(one("en", CASE_ID))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/reconciliation", () => {
  it.each(LOCALES)(
    "shows the open count of each kind, the details and a resolve form (%s)",
    async (locale) => {
      as("finance");
      const html = inProvider(await Reconciliation(list(locale)), locale);
      for (const kind of ["orphan", "missing", "cost", "payment"] as const) {
        expect(html).toContain(msgs(locale).reconciliation.kind[kind]);
      }
      expect(html).toContain(msgs(locale).reconciliation.detailKey.resourceId);
      expect(html).toContain(RESOURCE_ID);
      expect(html).toContain('name="kind" value="resolveDiscrepancy"');
      expect(html).toContain(`name="id" value="${DISCREPANCY_ID}"`);
      expect(state.asked).toEqual([[locale, "reconciliation"]]);
      expect(seen["reconList"]).toEqual([{ status: "open" }]);
    },
  );

  it("filters come only from the allow-listed values", async () => {
    as("ops");
    await Reconciliation(list("en", { kind: "cost", status: "all" }));
    await Reconciliation(list("en", { kind: "x", status: "y", after: "z" }));
    expect(seen["reconList"]).toEqual([{ kind: "cost" }, { status: "open" }]);
  });

  it("a resolved row has no form; an unavailable store shows its state and nothing else", async () => {
    as("ops");
    state.repos["reconciliation"] = {
      overview: async () => ok({ orphan: 0, missing: 0, cost: 0, payment: 0 }),
      list: async () => ok({ rows: [discrepancy({ status: "resolved" })], nextAfter: null }),
    };
    expect(inProvider(await Reconciliation(list("en")), "en")).not.toContain("resolveDiscrepancy");
    state.repos["reconciliation"] = { overview: async () => ({ ok: false, error: "forbidden" }) };
    const html = inProvider(await Reconciliation(list("en")), "en");
    expect(html).toContain(msgs("en").unavailable.title);
    expect(html).not.toContain(RESOURCE_ID);
  });

  it("shows the neutral page and none of the data when the guard refuses", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await Reconciliation(list("en")), "en");
    expect(html).not.toContain(RESOURCE_ID);
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

type Screen = "supportList" | "supportDetail" | "abuseList" | "abuseDetail" | "reconciliation";
const ANCHORS: { screen: Screen; file: string; classes: string[]; why: string }[] = [
  {
    screen: "supportList",
    file: "cart.html",
    classes: ["table-responsive-lg", "table", "compare", "seccolor", "title", "mergecolor"],
    why: "the request table is the table of the cart page",
  },
  {
    screen: "supportList",
    file: "elements.html",
    classes: ["cd-filter-block", "form-control"],
    why: "the filter is the form block of the elements page",
  },
  {
    screen: "supportDetail",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each block of the request page is the card of the checkout page",
  },
  {
    screen: "supportDetail",
    file: "cart.html",
    classes: ["table-responsive-lg", "compare"],
    why: "the audit trail is the table of the cart page",
  },
  {
    screen: "abuseList",
    file: "cart.html",
    classes: ["table-responsive-lg", "table", "compare", "seccolor", "title", "mergecolor"],
    why: "the case table is the table of the cart page",
  },
  {
    screen: "abuseList",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow"],
    why: "the open-case form sits in the card of the checkout page",
  },
  {
    screen: "abuseDetail",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each block of the case page is the card of the checkout page",
  },
  {
    screen: "abuseDetail",
    file: "payments.html",
    classes: ["badge"],
    why: "the case state is a badge of the payments page",
  },
  {
    screen: "reconciliation",
    file: "cart.html",
    classes: ["table-responsive-lg", "table", "compare", "seccolor", "title", "mergecolor"],
    why: "the discrepancy table is the table of the cart page",
  },
  {
    screen: "reconciliation",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow"],
    why: "the count of each kind is a card of the checkout page",
  },
];

describe("the support, abuse and reconciliation screens follow the mockup", () => {
  const render = async (screen: Screen, locale: Locale) => {
    as("ops");
    switch (screen) {
      case "supportList":
        as("support");
        return inProvider(await SupportList(list(locale)), locale);
      case "supportDetail":
        as("support");
        return inProvider(await SupportDetail(one(locale, REQUEST_ID)), locale);
      case "abuseList":
        return inProvider(await AbuseList(list(locale)), locale);
      case "abuseDetail":
        return inProvider(await AbuseDetail(one(locale, CASE_ID)), locale);
      case "reconciliation":
        return inProvider(await Reconciliation(list(locale)), locale);
    }
  };

  for (const anchor of ANCHORS) {
    it(`${anchor.screen} / ${anchor.file}: ${anchor.why}`, async () => {
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

  it("every class of every screen is defined by the theme, Bootstrap, Font Awesome or tc.css", async () => {
    const known = knownClasses();
    for (const screen of [
      "supportList",
      "supportDetail",
      "abuseList",
      "abuseDetail",
      "reconciliation",
    ] as const) {
      for (const locale of LOCALES) {
        const unknown = [...classTokens(await render(screen, locale))].filter(
          (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
        );
        expect(unknown, `${screen} in ${locale}`).toEqual([]);
      }
    }
  });
});
