import { shellMessages } from "@tc/ui";
import { loadKitMessages } from "@tc/ui/messages";
import type { Locale, Messages } from "@tc/ui/runtime";
import {
  THEME_CONTENT_CLASSES,
  THEME_STYLESHEETS,
  fontPreloads,
  themeAttributes,
} from "@tc/ui/theme";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";

const state = vi.hoisted(() => ({
  locale: "bn",
  nonceReads: 0,
  // What loadPageAdmin answers: a signed-in admin of a role, or a refusal.
  page: {
    kind: "ok",
    admin: { adminId: "0191a000-0000-7000-8000-0000000000ad", role: "ops", ip: "203.0.113.5" },
  } as
    | { kind: "ok"; admin: { adminId: string; role: string; ip: string } }
    | { kind: "denied" }
    | { kind: "signin" },
  asked: [] as unknown[],
}));

vi.mock("./server/page-admin.ts", () => ({
  loadPageAdmin: async (locale: string, id: string) => {
    state.asked.push([locale, id]);
    // The real loader redirects a visitor without a session to the sign-in.
    if (state.page.kind === "signin") throw new Error(`NEXT_REDIRECT /${locale}/login`);
    return state.page;
  },
}));
vi.mock("./server/actions.ts", () => ({
  signInAction: async () => ({ error: null }),
  signOutAction: async () => {},
}));

vi.mock("next-intl/server", () => ({
  getLocale: async () => state.locale,
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
    const all = (await import("./i18n/messages.ts")).adminMessages;
    let node = all[locale === "en" ? "en" : "bn"] as Messages | string | undefined;
    for (const part of namespace.split(".")) {
      node = typeof node === "object" ? node[part] : undefined;
    }
    return (key: string): string => {
      const value = typeof node === "object" ? node[key] : undefined;
      if (typeof value !== "string") throw new Error(`missing ${namespace}.${key}`);
      return value;
    };
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    state.nonceReads += 1;
    return new Headers({ "x-nonce": "test-nonce" });
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { default: RootLayout, metadata } = await import("./app/layout.tsx");
const { default: LocaleLayout } = await import("./app/[locale]/layout.tsx");
const { default: Page, generateMetadata } = await import("./app/[locale]/page.tsx");
const { default: NotFound } = await import("./app/not-found.tsx");
const { default: LoginPage, generateMetadata: loginMetadata } =
  await import("./app/[locale]/login/page.tsx");
const { default: SectionPage } = await import("./app/[locale]/[section]/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];

function inProvider(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={adminMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

const adminShellText = (locale: Locale) =>
  (shellMessages[locale]["Shell"] as { admin: { ops: string } }).admin;

beforeEach(() => {
  state.locale = "bn";
  state.nonceReads = 0;
  state.asked = [];
  state.page = {
    kind: "ok",
    admin: { adminId: "0191a000-0000-7000-8000-0000000000ad", role: "ops", ip: "203.0.113.5" },
  };
});

describe("admin today page", () => {
  it.each(LOCALES)("shows the OPS label, the title and the body (%s)", async (locale) => {
    const element = await Page({ params: Promise.resolve({ locale }) });
    const html = inProvider(element, locale);
    const messages = adminMessages[locale]["Admin"] as { home: { title: string; body: string } };
    expect(html).toContain(`<span class="tc-ops-label">${adminShellText(locale).ops}</span>`);
    expect(html).toContain(messages.home.title);
    expect(html).toContain(messages.home.body);
  });

  it("asks the guard for the today area in the locale of the request", async () => {
    await Page({ params: Promise.resolve({ locale: "en" }) });
    expect(state.asked).toEqual([["en", "today"]]);
  });

  it.each(LOCALES)("has one h2 for the title and no h1 (%s)", async (locale) => {
    const element = await Page({ params: Promise.resolve({ locale }) });
    const html = inProvider(element, locale);
    expect(html.match(/<h2[ >]/g)).toHaveLength(1);
    expect(html).not.toContain("<h1");
  });

  it("lists the entries of the role ops in the navigation and marks today current", async () => {
    const element = await Page({ params: Promise.resolve({ locale: "en" }) });
    const html = inProvider(element, "en");
    const side = /<[^>]*id="sidebar"[\s\S]*?<\/(?:aside|nav|div)>/.exec(html)?.[0] ?? "";
    expect(side.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('href="/en/customers"');
    expect(html).toContain('href="/en/operations"');
    expect(html).not.toContain('href="/en/payments"');
    expect(html).not.toContain('href="/en/admins"');
  });

  it("links the locale switch to / and /en", async () => {
    const element = await Page({ params: Promise.resolve({ locale: "bn" }) });
    const html = inProvider(element, "bn");
    expect(html).toContain('href="/en"');
  });

  it("shows the neutral page, and no shell and no navigation, when the guard refuses", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await Page({ params: Promise.resolve({ locale: "en" }) }), "en");
    const messages = adminMessages.en["Admin"] as { noAccess: { title: string } };
    expect(html).toContain(messages.noAccess.title);
    expect(html).not.toContain("tc-ops-label");
    expect(html).not.toContain("/en/customers");
    expect(html).not.toMatch(/mfa|allowlist|disabled|totp/i);
  });

  it("calls notFound for an unknown locale", async () => {
    await expect(Page({ params: Promise.resolve({ locale: "fr" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it.each(LOCALES)("generateMetadata gives the title of the locale (%s)", async (locale) => {
    const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
    const messages = adminMessages[locale]["Admin"] as { meta: { title: string } };
    expect(meta.title).toBe(messages.meta.title);
  });
});

describe("admin login page", () => {
  it.each(LOCALES)(
    "shows the three fields and the submit, with no admin shell (%s)",
    async (locale) => {
      const html = inProvider(await LoginPage({ params: Promise.resolve({ locale }) }), locale);
      const t = (adminMessages[locale]["Admin"] as { login: Record<string, string> }).login;
      for (const key of ["title", "email", "password", "code", "submit"]) {
        expect(html).toContain(t[key]);
      }
      expect(html).toContain('name="email"');
      expect(html).toContain('type="password"');
      expect(html).toContain('autoComplete="one-time-code"');
      expect(html).toContain(`name="locale" value="${locale}"`);
      expect(html).not.toContain("tc-ops-label");
    },
  );

  it("does not need a session: the guard is not asked", async () => {
    state.asked = [];
    await LoginPage({ params: Promise.resolve({ locale: "bn" }) });
    expect(state.asked).toEqual([]);
  });

  it("calls notFound for an unknown locale and gives a title", async () => {
    await expect(LoginPage({ params: Promise.resolve({ locale: "fr" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    const meta = await loginMetadata({ params: Promise.resolve({ locale: "en" }) });
    expect(meta.title).toBe("Admin sign-in");
  });
});

describe("admin section placeholder pages", () => {
  const params = (locale: string, section: string) => Promise.resolve({ locale, section });

  it("shows the frame with the title of the area and asks the guard for that area", async () => {
    const html = inProvider(await SectionPage({ params: params("en", "capacity") }), "en");
    expect(state.asked).toEqual([["en", "capacity"]]);
    expect(html).toContain("tc-ops-label");
    expect(html).toContain("Coming in the next step");
  });

  it("an unknown segment, today and a prototype name are 404", async () => {
    for (const section of ["nonsense", "today", "__proto__", "constructor", "login"]) {
      await expect(SectionPage({ params: params("en", section) }), section).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
    }
  });

  it("an unknown segment asks the guard first: no session goes to the sign-in, never to a 404", async () => {
    state.page = { kind: "signin" };
    for (const section of ["nonsense", "today", "this-path-does-not-exist"]) {
      state.asked = [];
      await expect(SectionPage({ params: params("bn", section) }), section).rejects.toThrow(
        "NEXT_REDIRECT /bn/login",
      );
      expect(state.asked, section).toEqual([["bn", "today"]]);
    }
  });

  it("an unknown segment with a refused session shows the neutral page, not a 404", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await SectionPage({ params: params("bn", "nonsense") }), "bn");
    expect(html).toContain(
      (adminMessages.bn["Admin"] as { noAccess: { title: string } }).noAccess.title,
    );
    expect(html).not.toContain("nonsense");
  });

  it("a refusal of the guard shows the neutral page", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await SectionPage({ params: params("bn", "admins") }), "bn");
    expect(html).not.toContain("tc-ops-label");
    expect(html).toContain(
      (adminMessages.bn["Admin"] as { noAccess: { title: string } }).noAccess.title,
    );
  });
});

describe("admin locale layout", () => {
  it("returns its children for bn and en", async () => {
    for (const locale of LOCALES) {
      const child = <p>child</p>;
      const result = await LocaleLayout({ children: child, params: Promise.resolve({ locale }) });
      expect(result).toBe(child);
    }
  });

  it("calls notFound for an unknown locale", async () => {
    await expect(
      LocaleLayout({ children: <p>x</p>, params: Promise.resolve({ locale: "fr" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("admin root layout", () => {
  async function render(locale: Locale): Promise<string> {
    state.locale = locale;
    const element = await RootLayout({ children: <p id="child">child</p> });
    return renderToStaticMarkup(element);
  }

  it.each(LOCALES)("sets lang and puts the child in the one content div (%s)", async (locale) => {
    const html = await render(locale);
    expect(html).toContain(`<html lang="${locale}"`);
    expect(html.split(`class="${THEME_CONTENT_CLASSES}"`)).toHaveLength(2);
    expect(html).toContain(`<div class="${THEME_CONTENT_CLASSES}"><p id="child">child</p></div>`);
  });

  it("the body attributes of the admin layout are blue and light", async () => {
    const html = await render("bn");
    const body = /<body([^>]*)>/.exec(html)?.[1] ?? "";
    const attributes = themeAttributes("admin");
    expect(attributes["data-color"]).toBe("blue");
    expect(attributes["data-background"]).toBe("light");
    for (const [name, value] of Object.entries(attributes)) {
      expect(body, name).toContain(`${name}="${value}"`);
    }
    expect(body).toContain('data-color="blue"');
    expect(body).toContain('data-background="light"');
  });

  it("links the stylesheets in order and preloads the fonts of the locale", async () => {
    for (const locale of LOCALES) {
      const html = await render(locale);
      const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs, locale).toEqual([...THEME_STYLESHEETS]);
      const preloads = [...html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(preloads, locale).toEqual(fontPreloads(locale).map((font) => font.href));
      expect(html).toContain('type="font/woff2"');
      expect(html).toContain('crossorigin="anonymous"');
    }
  });

  it("reads the nonce header once, so that the route is dynamic", async () => {
    await render("bn");
    expect(state.nonceReads).toBe(1);
  });

  it("is dynamic and noindex", async () => {
    const layout = await import("./app/layout.tsx");
    expect(layout.dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.icons).toEqual({ icon: "/brand/symbol.svg" });
  });

  it("holds no inline style and no script", async () => {
    const html = await render("en");
    expect(html).not.toContain(" style=");
    expect(html).not.toContain("<script");
  });
});

describe("admin not-found", () => {
  it.each(LOCALES)("shows the not-found text and a link home (%s)", async (locale) => {
    state.locale = locale;
    const element = await NotFound();
    const html = inProvider(element, locale);
    const shell = shellMessages[locale]["Shell"] as {
      notFound: { title: string; body: string };
      auth: { backHome: string };
    };
    expect(html).toContain(shell.notFound.title);
    expect(html).toContain(shell.notFound.body);
    expect(html).toContain(shell.auth.backHome);
    expect(html).toContain(`href="${locale === "en" ? "/en" : "/"}"`);
  });
});

describe("admin kit messages", () => {
  it("loadKitMessages gives the client components their namespace", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(loadKitMessages(locale))).toEqual(["kit"]);
    }
  });
});
