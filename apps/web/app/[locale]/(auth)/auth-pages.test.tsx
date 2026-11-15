import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@tc/ui/runtime";
import { BENGALI, h2Of, intl } from "./page-harness.tsx";

const state = vi.hoisted(() => ({
  locale: "bn" as "bn" | "en",
  available: true,
  session: null as null | { customerId: string },
  pending: null as null | { p: "signup" | "reset"; e: string; t: number },
  phoneStep: { kind: "unavailable" } as unknown,
}));

vi.mock("next-intl/server", async () => {
  const { webMessages: messages } = await import("../../../i18n/messages.ts");
  return {
    getLocale: async () => state.locale,
    getMessages: async () => messages[state.locale],
    getTranslations: async (options?: { locale?: "bn" | "en" }) =>
      createTranslator({
        locale: options?.locale ?? state.locale,
        messages: messages[options?.locale ?? state.locale],
      }),
  };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("../../../server/auth-page.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../server/auth-page.ts")>();
  return {
    ...actual,
    loadAuthPage: async (locale: string, next: unknown, opts: { guest: boolean }) => {
      if (opts.guest && state.session !== null) {
        const { landingPath } = await import("../../../server/auth/landing.ts");
        throw new Error(`REDIRECT:${landingPath(locale as Locale, next)}`);
      }
      return {
        runtime: { otp: {} },
        available: state.available,
        session: state.session,
      };
    },
    readPending: async () => state.pending,
  };
});
vi.mock("../../../server/phone-step.ts", () => ({
  loadPhoneStep: async () => state.phoneStep,
}));

const login = await import("./login/page.tsx");
const signup = await import("./signup/page.tsx");
const verify = await import("./verify/page.tsx");
const forgot = await import("./forgot-password/page.tsx");
const reset = await import("./reset-password/page.tsx");

type Query = Record<string, string | string[] | undefined>;
const PAGES = [
  { name: "login", module: login, path: "/login", titleKey: "card.title" },
  { name: "signup", module: signup, path: "/signup", titleKey: "card.title" },
  { name: "verify", module: verify, path: "/verify", titleKey: "verify.email.heading" },
  { name: "forgot", module: forgot, path: "/forgot-password", titleKey: "forgot.heading" },
  { name: "reset", module: reset, path: "/reset-password", titleKey: "reset.heading" },
] as const;

async function render(
  page: (typeof PAGES)[number],
  locale: Locale,
  query: Query = {},
): Promise<string> {
  state.locale = locale;
  const element = await (
    page.module.default as (p: {
      params: Promise<{ locale: string }>;
      searchParams: Promise<Query>;
    }) => Promise<React.ReactNode>
  )({ params: Promise.resolve({ locale }), searchParams: Promise.resolve(query) });
  return intl(element, locale);
}

beforeEach(() => {
  state.locale = "bn";
  state.available = true;
  state.session = null;
  state.pending = null;
  state.phoneStep = { kind: "unavailable" };
});

describe("the five pages render in bn and en with the real messages", () => {
  for (const page of PAGES) {
    for (const locale of ["bn", "en"] as const) {
      it(`${page.name} in ${locale}: a card with an h2 and an intro, no style attribute, no script`, async () => {
        const html = await render(page, locale);
        const heading = h2Of(html);
        expect(heading.length, "h2").toBeGreaterThan(0);
        if (locale === "bn") expect(heading).toMatch(BENGALI);
        else expect(heading).not.toMatch(BENGALI);
        expect(html).toContain('class="fullrock config sec-bg3 motpath bg-colorstyle"');
        expect(html).toContain("tc-footer-aws");
        expect(html).not.toMatch(/\sstyle\s*=/);
        // The only script React itself adds to a form with an action function is the replay hook.
        const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? [];
        expect(scripts.filter((script) => !script.includes("$$reactFormReplay"))).toEqual([]);
        expect(html).toContain("<form");
      });
    }

    it(`${page.name}: with no identity provider it shows the not-available state and no form`, async () => {
      state.available = false;
      for (const locale of ["bn", "en"] as const) {
        const html = await render(page, locale);
        expect(html, `${page.name} ${locale}`).not.toContain("<form");
        expect(html).toContain("tc-empty");
        expect(html).toContain(locale === "bn" ? 'href="/"' : 'href="/en"');
      }
    });

    it(`${page.name}: is force-dynamic and noindex`, async () => {
      expect(page.module.dynamic).toBe("force-dynamic");
    });
  }

  it("the Bengali page does not carry the English title and the English page not the Bengali", async () => {
    const bn = await render(PAGES[0], "bn");
    const en = await render(PAGES[0], "en");
    expect(bn).not.toContain("Sign in or create a new account");
    expect(en).not.toContain("সাইন ইন অথবা");
  });

  it("a locale that is neither bn nor en is a missing page", async () => {
    for (const page of PAGES) {
      await expect(
        (
          page.module.default as (p: {
            params: Promise<{ locale: string }>;
            searchParams: Promise<Query>;
          }) => Promise<unknown>
        )({ params: Promise.resolve({ locale: "fr" }), searchParams: Promise.resolve({}) }),
        page.name,
      ).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });
});

describe("/login: next, banners and signed-in customers", () => {
  it("a hostile next is not rendered; an allowed one is", async () => {
    for (const bad of ["//evil.com", "https://evil.com", "/walletx", "javascript:x", ""]) {
      const html = await render(PAGES[0], "bn", { next: bad });
      expect(html, bad).not.toContain('name="next"');
      expect(html, bad).not.toContain("evil.com");
    }
    const ok = await render(PAGES[0], "bn", { next: "/wallet" });
    expect(ok).toContain('name="next" value="/wallet"');
    expect(ok).toContain('href="/en/signup?next=%2Fwallet"');
  });

  it("has no language switch, in bn or en (WPU-X19: only the home page is bilingual)", async () => {
    for (const locale of ["bn", "en"] as const) {
      const html = await render(PAGES[0], locale, {});
      expect(html, locale).not.toContain("hrefLang=");
      expect(html, locale).not.toContain("tc-auth-lang");
    }
  });

  it("?verified=1 and ?reset=1 show a success alert; any other value shows none", async () => {
    const verified = await render(PAGES[0], "en", { verified: "1" });
    expect(verified).toContain("alert alert-success");
    expect(verified).toContain("Email verified. You can sign in now.");
    const reset = await render(PAGES[0], "en", { reset: "1" });
    expect(reset).toContain("Password changed.");
    for (const bad of ["2", "<script>alert(1)</script>", "true", ""]) {
      const html = await render(PAGES[0], "en", { verified: bad, reset: bad });
      expect(html, bad).not.toContain("alert-success");
      expect(html, bad).not.toContain("<script>alert");
    }
  });

  it("the banner never chooses a target", async () => {
    const html = await render(PAGES[0], "bn", { verified: "1", next: "//evil.com" });
    expect(html).not.toContain("evil.com");
  });

  it("a signed-in customer is sent to the panel from every guest page, and /verify stays open", async () => {
    state.session = { customerId: "11111111-1111-4111-8111-111111111111" };
    for (const page of [PAGES[0], PAGES[1], PAGES[3], PAGES[4]]) {
      await expect(render(page, "bn"), page.name).rejects.toThrow("REDIRECT:/en/wallet");
    }
    await expect(render(PAGES[0], "en", { next: "/wallet?x=1" })).rejects.toThrow(
      "REDIRECT:/en/wallet?x=1",
    );
    await expect(render(PAGES[0], "bn", { next: "//evil.com" })).rejects.toThrow(
      "REDIRECT:/en/wallet",
    );
    state.phoneStep = { kind: "unavailable" };
    await expect(render(PAGES[2], "bn")).resolves.toContain("fullrock-content");
  });
});

describe("/signup, /forgot-password and /reset-password content", () => {
  it("/signup has the personal and security groups, the three consents and no company or account type field", async () => {
    const html = await render(PAGES[1], "en");
    expect(html).toContain('<div class="seccolor"><small>Personal information</small></div>');
    expect(html).toContain('<div class="mergecolor"><small>Account security</small></div>');
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    for (const name of ["fullName", "email", "phone", "password", "passwordConfirm"]) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).not.toMatch(/companyName|accountType|company/i);
    expect(html).toContain('autoComplete="new-password"');
  });

  it("/forgot-password is the one-field form of the template and /reset-password carries the code field", async () => {
    const forgotHtml = await render(PAGES[3], "en");
    expect(forgotHtml).toContain(
      '<div class="text-center"><p class="section-subheading mergecolor">',
    );
    expect(forgotHtml).toContain('<div class="mt-50">');
    expect(forgotHtml.match(/name="email"/g)).toHaveLength(1);
    state.pending = { p: "reset", e: "a@example.test", t: Math.floor(Date.now() / 1000) };
    const resetHtml = await render(PAGES[4], "en");
    expect(resetHtml).toContain('value="a@example.test"');
    expect(resetHtml).toContain('name="code"');
    expect(resetHtml).toContain('autoComplete="one-time-code"');
  });

  it("/reset-password does not prefill from a signup pending cookie", async () => {
    state.pending = { p: "signup", e: "a@example.test", t: Math.floor(Date.now() / 1000) };
    const html = await render(PAGES[4], "en");
    expect(html).not.toContain("a@example.test");
  });
});
