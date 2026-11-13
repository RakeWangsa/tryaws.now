import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import type { AuditRow } from "@tc/db";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";

const ME = "0191a000-0000-7000-8000-0000000000a1";
const OTHER = "0191a000-0000-7000-8000-0000000000a2";
const ROW_ID = "0191a000-0000-7000-8000-0000000000b1";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  searched: [] as unknown[],
  search: undefined as unknown,
  detail: undefined as unknown,
  admins: undefined as unknown,
  directory: undefined as unknown,
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
vi.mock("./server/admins-actions.ts", () => ({ adminsAction: async () => {} }));
vi.mock("./server/runtime.ts", () => ({
  readAsAdmin: async (_actor: unknown, fn: (repos: unknown) => Promise<unknown>) =>
    fn({
      audit: {
        search: async (input: unknown) => {
          state.searched.push(input);
          return state.search;
        },
        detail: async () => state.detail,
      },
      adminUsers: { list: async () => state.admins },
    }),
  adminDirectory: () => state.directory,
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

const { default: AuditPage } = await import("./app/[locale]/audit/page.tsx");
const { default: AuditRowPage } = await import("./app/[locale]/audit/[id]/page.tsx");
const { default: AdminsPage } = await import("./app/[locale]/admins/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const T0 = new Date("2026-11-10T06:00:00.000Z");

const auditRow = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: ROW_ID,
  createdAt: T0,
  actorType: "admin",
  actorId: OTHER,
  action: "payment.refund",
  targetType: "payment",
  targetId: "p-77",
  ip: "198.51.100.7",
  userAgent: "agent/1",
  reason: "refund checked",
  before: { status: "credited" },
  after: { status: "refunded", phone: "01712****78" },
  extra: {},
  ...over,
});

const ok = <T,>(value: T) => ({ ok: true, value, replayed: false });
const adminRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  cognitoSub: "sub-" + id,
  role: "ops",
  status: "active",
  createdAt: T0,
  ...over,
});

function inProvider(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={adminMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}
const as = (role: string, adminId = ME) => {
  state.page = { kind: "ok", admin: { adminId, role, ip: "203.0.113.5" } };
};
const listParams = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
const rowParams = (locale: string, id = ROW_ID) => ({ params: Promise.resolve({ locale, id }) });

beforeEach(() => {
  as("support");
  state.asked = [];
  state.searched = [];
  state.search = ok({ rows: [auditRow()], nextAfter: null });
  state.detail = ok(auditRow());
  state.admins = ok({
    rows: [adminRow(ME, { role: "superadmin" }), adminRow(OTHER)],
    nextAfter: null,
  });
  state.directory = {
    describe: async () =>
      new Map([
        ["sub-" + OTHER, { email: "olivia@example.com", lastSignInAt: T0, totpEnrolled: true }],
      ]),
  };
});

describe("/audit", () => {
  it.each(LOCALES)(
    "every role reads the log: rows, a link to the details, a GET filter (%s)",
    async (locale) => {
      for (const role of ["support", "finance", "ops", "superadmin"]) {
        as(role);
        const html = inProvider(await AuditPage(listParams(locale)), locale);
        expect(html).toContain("payment.refund");
        expect(html).toContain(`/audit/${ROW_ID}`);
        expect(html).toContain('method="get"');
        expect(html).not.toMatch(/method="post"/i);
      }
      expect(state.asked.every((a) => (a as string[])[1] === "audit")).toBe(true);
    },
  );

  it("passes the filters of the URL to the repository and drops values of a wrong shape", async () => {
    await AuditPage(
      listParams("en", {
        actor: OTHER,
        actorType: "admin",
        action: "payment.",
        from: "2026-11-01",
        to: "2026-11-02",
        targetType: "Bad Type",
      }),
    );
    const [input] = state.searched as Record<string, unknown>[];
    expect(input).toMatchObject({ actorId: OTHER, actorType: "admin", action: "payment." });
    expect(input).not.toHaveProperty("targetType");
    expect((input?.from as Date).toISOString()).toBe("2026-10-31T18:00:00.000Z");
  });

  it("shows the export link to a superadmin only, and it carries the filter", async () => {
    as("support");
    expect(
      inProvider(await AuditPage(listParams("en", { action: "payment." })), "en"),
    ).not.toContain("/api/audit-export");
    as("superadmin");
    const html = inProvider(await AuditPage(listParams("en", { action: "payment." })), "en");
    // R10: a GET form that carries the filter and asks for the reason; a bare link would skip it.
    expect(html).toContain('action="/api/audit-export"');
    expect(html).toContain('<input type="hidden" name="action" value="payment."/>');
    expect(html).toMatch(/<input[^>]*required=""[^>]*name="reason"/);
    expect(html).not.toContain('href="/api/audit-export');
  });

  it("has no form that posts: the filter and the export are GET forms", async () => {
    as("superadmin");
    for (const locale of LOCALES) {
      const html = inProvider(await AuditPage(listParams(locale)), locale);
      expect(html.match(/<form/g)).toHaveLength(2);
      expect(html.match(/method="get"/g)).toHaveLength(2);
      expect(html).not.toMatch(/method="post"/i);
    }
    as("support");
    const html = inProvider(await AuditPage(listParams("en")), "en");
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).not.toContain('type="hidden"');
  });

  it("links to the next page with the same filter", async () => {
    state.search = ok({ rows: [auditRow()], nextAfter: ROW_ID });
    const html = inProvider(await AuditPage(listParams("en", { action: "payment." })), "en");
    expect(html).toContain(`action=payment.&amp;after=${ROW_ID}`);
  });

  it.each(LOCALES)(
    "an empty result and a failing database show fixed text (%s)",
    async (locale) => {
      state.search = ok({ rows: [], nextAfter: null });
      expect(inProvider(await AuditPage(listParams(locale)), locale)).toContain(
        locale === "en" ? "No records found" : "কোনো রেকর্ড পাওয়া যায়নি",
      );
      state.search = { ok: false, error: "forbidden" };
      const html = inProvider(await AuditPage(listParams(locale)), locale);
      expect(html).not.toContain("payment.refund");
      expect(html).not.toContain("forbidden");
    },
  );

  it("a refusal by the guard shows no data (fail closed)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await AuditPage(listParams("en")), "en");
    expect(html).not.toContain("payment.refund");
    expect(state.searched).toEqual([]);
  });
});

describe("/audit/[id]", () => {
  it.each(LOCALES)("shows actor, reason, IP, target and before and after (%s)", async (locale) => {
    const html = inProvider(await AuditRowPage(rowParams(locale)), locale);
    for (const text of [OTHER, "refund checked", "198.51.100.7", "p-77", "credited", "refunded"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain("01712****78");
    expect(html).not.toMatch(/<form/);
  });

  it("a bad or missing id is a 404, and the guard shows nothing", async () => {
    await expect(AuditRowPage(rowParams("en", "nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.detail = { ok: false, error: "not_found" };
    await expect(AuditRowPage(rowParams("en"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.page = { kind: "denied" };
    state.detail = ok(auditRow());
    expect(inProvider(await AuditRowPage(rowParams("en")), "en")).not.toContain("refund checked");
  });
});

describe("/admins", () => {
  beforeEach(() => as("superadmin"));

  it.each(LOCALES)(
    "lists the admins with role, status, masked email, last sign-in and TOTP, and the forms (%s)",
    async (locale) => {
      const html = inProvider(await AdminsPage(listParams(locale)), locale);
      expect(state.asked).toEqual([[locale, "admins"]]);
      expect(html).toContain("o***@example.com");
      expect(html).not.toContain("olivia@example.com");
      expect(html).toContain(locale === "en" ? "Enrolled" : "চালু");
      for (const kind of ["setAdminRole", "disableAdmin", "resetAdminMfa", "inviteAdmin"]) {
        expect(html, kind).toContain(`value="${kind}"`);
      }
      // every form asks for a reason
      expect(html.match(/name="reason"/g)?.length).toBe(html.match(/<form/g)?.length);
    },
  );

  it("no form names the acting admin or an approver: only the target, role, email, reason", async () => {
    const html = inProvider(await AdminsPage(listParams("en")), "en");
    const names = new Set([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]));
    expect([...names].sort()).toEqual(["email", "id", "kind", "locale", "reason", "role"].sort());
    expect(html).not.toMatch(/approv|actor|requestedBy/i);
  });

  it("the own row offers no role change and no disable", async () => {
    const html = inProvider(await AdminsPage(listParams("en")), "en");
    const own = html.split(`value="${ME}"`)[1]?.split("</form>")[0] ?? "";
    expect(own).not.toContain('value="setAdminRole"');
    expect(own).not.toContain('value="disableAdmin"');
    expect(own).toContain("This is your own account");
    const other = html.split(`value="${OTHER}"`)[1]?.split("</form>")[0] ?? "";
    expect(other).toContain('value="setAdminRole"');
    expect(other).toContain('value="disableAdmin"');
  });

  it("a disabled admin offers enable instead of disable", async () => {
    state.admins = ok({ rows: [adminRow(OTHER, { status: "disabled" })], nextAfter: null });
    const html = inProvider(await AdminsPage(listParams("en")), "en");
    expect(html).toContain('value="enableAdmin"');
    expect(html).not.toContain('value="disableAdmin"');
  });

  it("when the sign-in service does not answer, the records stay and the cells say unknown", async () => {
    state.directory = {
      describe: async () => {
        throw new Error("down");
      },
    };
    const html = inProvider(await AdminsPage(listParams("en")), "en");
    expect(html).toContain("The sign-in service is not answering");
    expect(html).toContain('value="disableAdmin"');
    expect(html).not.toContain("down");
  });

  it("shows the result of the last action", async () => {
    const html = inProvider(await AdminsPage(listParams("en", { result: "self" })), "en");
    expect(html).toContain("You cannot change your own role");
    expect(inProvider(await AdminsPage(listParams("en", { result: "<b>x" })), "en")).not.toContain(
      "<b>x",
    );
  });

  it("a refusal by the guard shows no data, and a failing database shows a fixed state", async () => {
    state.page = { kind: "denied" };
    expect(inProvider(await AdminsPage(listParams("en")), "en")).not.toContain("Invite");
    as("superadmin");
    state.admins = { ok: false, error: "forbidden" };
    const html = inProvider(await AdminsPage(listParams("en")), "en");
    expect(html).toContain("The data could not be loaded");
    expect(html).not.toContain("forbidden");
  });
});

// The cross-check with the mockup. The mockup has no audit or admin-users page (the pages that exist
// are listed in design/mockup/template), so the anchors are the pages the blocks come from: the
// checkout card, the cart table, the elements form block and the payments badge.
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

type Screen = "audit" | "auditRow" | "admins";
const ANCHORS: { screen: Screen; file: string; classes: string[]; why: string }[] = [
  {
    screen: "audit",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "the filter block is the card of the checkout page",
  },
  {
    screen: "audit",
    file: "cart.html",
    classes: ["table-responsive-lg", "compare", "seccolor"],
    why: "the log is the table of the cart page",
  },
  {
    screen: "audit",
    file: "elements.html",
    classes: ["cd-filter-block", "form-control"],
    why: "the filter form is the form block of the elements page",
  },
  {
    screen: "audit",
    file: "payments.html",
    classes: ["badge", "bg-purple"],
    why: "the actor type is a badge of the payments page",
  },
  {
    screen: "auditRow",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each block of the details is the card of the checkout page",
  },
  {
    screen: "admins",
    file: "cart.html",
    classes: ["table-responsive-lg", "compare", "seccolor"],
    why: "the admin list is the table of the cart page",
  },
  {
    screen: "admins",
    file: "elements.html",
    classes: ["cd-filter-block", "form-control"],
    why: "the invite and change forms are the form block of the elements page",
  },
  {
    screen: "admins",
    file: "payments.html",
    classes: ["badge", "bg-purple"],
    why: "the status is a badge of the payments page",
  },
  {
    screen: "admins",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "the invite block is the card of the checkout page",
  },
];

describe("the audit and admin screens follow the mockup", () => {
  const render = async (screen: Screen, locale: Locale) => {
    as("superadmin");
    if (screen === "audit") return inProvider(await AuditPage(listParams(locale)), locale);
    if (screen === "auditRow") return inProvider(await AuditRowPage(rowParams(locale)), locale);
    return inProvider(await AdminsPage(listParams(locale)), locale);
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

  it("every class of the three screens is defined by the theme, Bootstrap, Font Awesome or tc.css", async () => {
    const known = knownClasses();
    for (const screen of ["audit", "auditRow", "admins"] as const) {
      for (const locale of LOCALES) {
        const unknown = [...classTokens(await render(screen, locale))].filter(
          (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
        );
        expect(unknown, `${screen} in ${locale}`).toEqual([]);
      }
    }
  });
});
