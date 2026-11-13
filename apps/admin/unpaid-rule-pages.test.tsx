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

// WPU-Z4: the screen /operations/unpaid-rule. The page asks the guard first with its own roles (every admin
// reads), the real loader reads the switch of each market and the audit log through the repositories (faked
// here), a superadmin gets the turn-on form with a reason and the confirm box, ops and superadmin the turn-off
// form, finance and support read only.
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const BY = "0191a000-0000-7000-8000-0000000000ae";
const KEY = "lifecycle_unpaid_enabled";
const LEAK = "AccessDenied arn:aws:iam::123456789012:role/TcProvisioner owner@example.com";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
type W<T> = { ok: true; value: T; replayed: boolean } | { ok: false; error: string };
const okW = <T,>(value: T): W<T> => ({ ok: true, value, replayed: false });

const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  markets: ["BD"] as string[],
  read: undefined as unknown,
  audit: undefined as unknown,
  readThrows: false,
}));

vi.mock("./server/page-admin.ts", () => ({
  loadPageAdmin: async (locale: string, id: string, roles?: readonly string[]) => {
    state.asked.push([locale, id, roles]);
    return state.page;
  },
}));
vi.mock("./server/actions.ts", () => ({
  signInAction: async () => ({ error: null }),
  signOutAction: async () => {},
}));
vi.mock("./server/ops-actions.ts", () => ({
  operationAction: async () => {},
  clearPlanChangeMarkAction: async () => {},
  switchUnpaidRuleAction: async () => {},
}));
// The loader is the real one; only the transaction and the repositories are replaced.
vi.mock("./server/pricing-runtime.ts", () => ({
  readTx: async (fn: (tx: unknown) => unknown) => {
    if (state.readThrows) throw new Error(`database down: ${LEAK}`);
    return fn({});
  },
}));
vi.mock("@tc/db", async (importActual) => ({
  ...(await importActual<typeof import("@tc/db")>()),
  adminRepos: () => ({
    settings: { read: async () => state.read },
    audit: { search: async () => state.audit },
  }),
  readMarketCodes: async () => state.markets,
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

const { default: UnpaidRulePage } = await import("./app/[locale]/operations/unpaid-rule/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const T1 = new Date("2026-11-12T06:00:00.000Z");
const T2 = new Date("2026-11-13T06:00:00.000Z");
const msgs = (locale: Locale) =>
  adminMessages[locale]["AdminUnpaidRule"] as Record<string, Record<string, string> & string>;

const stored = (enabled: boolean, source = "stored") =>
  okW({ key: KEY, market: "BD", enabled, source });
const auditRow = (over: Record<string, unknown> = {}) => ({
  id: "0191a000-0000-7000-8000-0000000000f1",
  createdAt: T1,
  actorType: "admin",
  actorId: BY,
  action: "setting.set",
  targetType: "setting",
  targetId: `BD:${KEY}`,
  ip: "203.0.113.9",
  userAgent: null,
  reason: "pilot customers",
  before: null,
  after: { value: true },
  extra: {},
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
const params = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
const render = async (locale: Locale = "en", search: Record<string, string> = {}) =>
  inProvider(await UnpaidRulePage(params(locale, search)), locale);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
// A message as React writes it into the markup.
const escaped = (message: string | undefined) =>
  (message ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const states = (html: string) =>
  [...html.matchAll(/name="state" value="(on|off)"/g)].map((m) => m[1]);
const confirmBox = (html: string) => /<input[^>]*name="confirm"[^>]*>/.exec(html)?.[0] ?? null;

beforeEach(() => {
  state.asked = [];
  state.markets = ["BD"];
  state.read = stored(false, "none");
  state.audit = okW({ rows: [], nextAfter: null });
  state.readThrows = false;
  as("superadmin");
});

describe("/operations/unpaid-rule", () => {
  it("asks the guard in the operations area with the read roles of the page, before any read", async () => {
    await render("en");
    expect(state.asked).toEqual([
      ["en", "operations", ["support", "finance", "ops", "superadmin"]],
    ]);
  });

  it("shows the state, the description of the rule and the roles line (bn and en)", async () => {
    for (const locale of LOCALES) {
      const html = await render(locale);
      const m = msgs(locale);
      expect(html).toContain(m["title"]);
      expect(html).toContain(m["market"]?.replace("{market}", "BD"));
      expect(html).toContain(m["state"]?.["off"]);
      for (const line of ["retry", "suspend", "delete", "approval", "off"]) {
        expect(html, line).toContain(escaped(m["about"]?.[line]));
      }
      expect(html).toContain(escaped(m["roles"]));
      expect(html).toContain(escaped(m["source"]?.["none"]));
    }
  });

  it("a superadmin gets the turn-on form while it is off: reason and confirm box, no turn-off form", async () => {
    for (const locale of LOCALES) {
      const html = await render(locale);
      expect(states(html)).toEqual(["on"]);
      expect(html).toContain('name="reason"');
      const box = confirmBox(html);
      expect(box).toContain('type="checkbox"');
      expect(box).toContain('value="on"');
      expect(box).toContain("required");
      expect(html).toContain(escaped(msgs(locale)["turnOn"]?.["confirm"]));
      expect(html).toContain('name="market" value="BD"');
      expect(html).toContain(`name="locale" value="${locale}"`);
    }
  });

  it("while it is on, ops and superadmin get the turn-off form (no confirm box) and no turn-on form", async () => {
    state.read = stored(true);
    for (const role of ["ops", "superadmin"]) {
      as(role);
      const html = await render("en");
      expect(states(html), role).toEqual(["off"]);
      expect(html).not.toContain('name="confirm"');
      expect(text(html)).toContain("State: On");
    }
  });

  it("ops cannot turn it on: while it is off, ops gets no form", async () => {
    as("ops");
    const html = await render("en");
    expect(states(html)).toEqual([]);
    expect(html).not.toContain('name="reason"');
  });

  it("finance and support read the state and the last change, with no form", async () => {
    state.read = stored(true);
    state.audit = okW({ rows: [auditRow()], nextAfter: null });
    for (const role of ["finance", "support"]) {
      as(role);
      for (const locale of LOCALES) {
        const html = await render(locale);
        expect(states(html), role).toEqual([]);
        expect(html).not.toContain("<form action=");
        expect(html).toContain(msgs(locale)["readOnly"]);
        expect(html).toContain(msgs(locale)["last"]?.["turnedOn"]);
      }
    }
  });

  it("the last change comes from the audit log: who (a short id), when and why; a replay row is skipped", async () => {
    state.read = stored(true);
    state.audit = okW({
      rows: [
        auditRow({ createdAt: T2, reason: "again", before: { value: true } }),
        auditRow({ reason: "pilot customers" }),
      ],
      nextAfter: null,
    });
    const html = text(await render("en"));
    expect(html).toContain("Change: Turned on");
    expect(html).toContain(`By: #${BY.slice(0, 8)}`);
    expect(html).toContain("Reason: pilot customers");
    expect(html).not.toContain("Reason: again");
    expect(html).not.toContain(BY);
  });

  it("no change in the audit log says so", async () => {
    expect(await render("en")).toContain(msgs("en")["last"]?.["none"]);
  });

  it("a stored value that is not a boolean is off, says so, and offers the turn-off form to clean it", async () => {
    state.read = stored(false, "invalid");
    as("ops");
    const html = await render("en");
    expect(html).toContain(msgs("en")["source"]?.["invalid"]);
    expect(states(html)).toEqual(["off"]);
    as("superadmin");
    expect(states(await render("en"))).toEqual(["on", "off"]);
  });

  it("the forms carry no admin, role or key field: those are the session's and the flow's", async () => {
    const html = await render("en");
    expect(html).not.toMatch(/name="(?:key|adminId|admin|role|actor|setBy|value)"/i);
  });

  it("shows the result of the action, and drops a result that is not one of ours", async () => {
    const ok = await render("en", { result: "ok" });
    expect(ok).toContain(msgs("en")["result"]?.["ok"]);
    const denied = await render("en", { result: "denied" });
    expect(denied).toContain('role="alert"');
    expect(denied).toContain(msgs("en")["result"]?.["denied"]);
    const odd = await render("en", { result: "<script>" });
    expect(odd).not.toContain("&lt;script&gt;");
  });

  it("the language switch stays on the page (finance and support cannot open /operations)", async () => {
    as("finance");
    const html = await render("en");
    expect(html).toContain('href="/operations/unpaid-rule"');
  });

  it("no market is an empty screen", async () => {
    state.markets = [];
    const html = await render("en");
    expect(html).toContain(msgs("en")["empty"]?.["title"]);
    expect(states(html)).toEqual([]);
  });

  it("a refusal by the guard shows no data and reads nothing", async () => {
    state.page = { kind: "denied" };
    state.read = stored(true);
    const html = await render("en");
    expect(html).not.toContain(msgs("en")["about"]?.["retry"]);
    expect(html).not.toContain('name="state"');
  });

  it("a refusal of the repository (disabled admin) shows the neutral page", async () => {
    state.read = { ok: false, error: "forbidden" };
    const html = await render("en");
    expect(html).not.toContain(msgs("en")["about"]?.["retry"]);
    expect(html).not.toContain('name="state"');
  });

  it("a failing database shows the fixed unavailable page and never the text of the error", async () => {
    state.readThrows = true;
    const html = await render("en");
    expect(html).toContain(msgs("en")["unavailable"]?.["title"]);
    expect(html).not.toContain("AccessDenied");
    expect(html).not.toContain("arn:aws");
    expect(html).not.toMatch(/\b\d{12}\b/);
    expect(html).not.toContain("owner@example.com");
  });

  it("a locale that is not ours is a 404", async () => {
    await expect(UnpaidRulePage(params("de"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

// The cross-check with the mockup: the classes of the screen are the classes the theme pages use, and every
// class is defined by the theme, Bootstrap, Font Awesome or tc.css.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../..", "design/mockup/template");
function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const attribute of html.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}
const mockup = (file: string) => classTokens(readFileSync(resolve(mockupRoot, file), "utf8"));

describe("the unpaid-rule screen follows the mockup", () => {
  const ANCHORS = [
    {
      file: "checkout.html",
      classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
      why: "each market and the description are the card of the checkout page",
    },
    {
      file: "elements.html",
      classes: ["cd-filter-block", "cd-filter-content"],
      why: "the switch form is the form block of the elements page",
    },
    {
      file: "payments.html",
      classes: ["badge"],
      why: "the state is a badge of the payments page",
    },
  ];

  for (const anchor of ANCHORS) {
    it(`${anchor.file}: ${anchor.why}`, async () => {
      const inMockup = mockup(anchor.file);
      expect(
        anchor.classes.filter((c) => !inMockup.has(c)),
        `not in ${anchor.file}`,
      ).toEqual([]);
      for (const locale of LOCALES) {
        const tokens = classTokens(await render(locale));
        expect(
          anchor.classes.filter((c) => !tokens.has(c)),
          locale,
        ).toEqual([]);
      }
    });
  }

  it("every class of the screen is defined by the theme, Bootstrap, Font Awesome or tc.css", async () => {
    const known = knownClasses();
    state.audit = okW({ rows: [auditRow()], nextAfter: null });
    for (const read of [stored(false, "none"), stored(true), stored(false, "invalid")]) {
      state.read = read;
      for (const role of ["superadmin", "finance"]) {
        as(role);
        for (const locale of LOCALES) {
          const unknown = [...classTokens(await render(locale))].filter(
            (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
          );
          expect(unknown, `${role} in ${locale}`).toEqual([]);
        }
      }
    }
  });
});
