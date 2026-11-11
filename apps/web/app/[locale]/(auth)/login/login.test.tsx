import { describe, expect, it, vi } from "vitest";
import { intl } from "../page-harness.tsx";

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

const { LoginContent } = await import("./LoginContent.tsx");

const render = (locale: "bn" | "en", over: Partial<Parameters<typeof LoginContent>[0]> = {}) =>
  intl(<LoginContent locale={locale} next={undefined} banner={null} available {...over} />, locale);

describe("the login form (16.9)", () => {
  it("has username and current-password autocomplete, email and password types, and no remember-me", () => {
    for (const locale of ["bn", "en"] as const) {
      const html = render(locale);
      expect(html).toContain('autoComplete="username"');
      expect(html).toContain('autoComplete="current-password"');
      expect(html).toContain('type="email"');
      expect(html).toContain('type="password"');
      expect(html).not.toMatch(/remember/i);
      expect(html).not.toContain('type="checkbox"');
    }
  });

  it("links to forgot-password and signup in the locale and carries the locale as a hidden field", () => {
    const en = render("en");
    expect(en).toContain('href="/en/forgot-password"');
    expect(en).toContain('href="/en/signup"');
    expect(en).toContain('name="locale" value="en"');
    const bn = render("bn");
    expect(bn).toContain('href="/forgot-password"');
    expect(bn).toContain('name="locale" value="bn"');
  });

  it("shows the matching success banner and nothing for null", () => {
    expect(render("en", { banner: "verified" })).toContain("Email verified.");
    expect(render("en", { banner: "reset" })).toContain("Password changed.");
    expect(render("en")).not.toContain("alert-success");
  });

  it("the submit button carries its icon and the text, and the form has the single yellow button", () => {
    const html = render("en");
    expect(html.match(/btn-default-yellow-fill/g)).toHaveLength(1);
    expect(html).toContain("fas fa-lock");
    expect(html).toContain("Sign in");
  });

  it("re-checks next before it reaches the form", () => {
    expect(render("en", { next: "//evil.com" })).not.toContain('name="next"');
    expect(render("en", { next: "/wallet" })).toContain('name="next" value="/wallet"');
  });
});
