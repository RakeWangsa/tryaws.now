import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "./i18n/messages.ts";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { default: GalleryPage } = await import("./app/[locale]/dev/ui/page.tsx");
const { default: ShellPage } = await import("./app/[locale]/dev/ui/[shell]/page.tsx");

function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

const galleryProps = (locale: string) => ({ params: Promise.resolve({ locale }) });
const shellProps = (locale: string, shell: string, page?: string | string[]) => ({
  params: Promise.resolve({ locale, shell }),
  searchParams: Promise.resolve(page === undefined ? {} : { page }),
});

/** The link of the navigation entry that carries aria-current (the class attribute comes between). */
const current = (shell: string, id: string): RegExp =>
  new RegExp(`href="/en/dev/ui/${shell}\\?page=${id}"[^>]*aria-current="page"`);

afterEach(() => {
  vi.unstubAllEnvs();
});

function production(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TC_DEV_UI", "");
  vi.stubEnv("TC_STAGE", "");
}

describe("web /dev/ui", () => {
  it("page calls notFound when isDevUiEnabled is false", async () => {
    production();
    await expect(GalleryPage(galleryProps("bn"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(ShellPage(shellProps("bn", "app"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not served on the production stage, even with the flag on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TC_DEV_UI", "on");
    vi.stubEnv("TC_STAGE", "production");
    await expect(GalleryPage(galleryProps("en"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("page renders when TC_DEV_UI=on", async () => {
    production();
    vi.stubEnv("TC_DEV_UI", "on");
    for (const locale of ["bn", "en"] as const) {
      const markup = html(await GalleryPage(galleryProps(locale)), locale);
      expect(markup, locale).toContain('data-gallery="Card"');
      expect(markup, locale).toContain('data-gallery-group="aws"');
      expect(markup, locale).toContain(`href="${locale === "en" ? "/en" : ""}/dev/ui/app"`);
    }
  });

  it("calls notFound for an unknown locale", async () => {
    await expect(GalleryPage(galleryProps("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(ShellPage(shellProps("fr", "app"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the shell page renders public, auth and app", async () => {
    for (const shell of ["public", "auth", "app"]) {
      const markup = html(await ShellPage(shellProps("en", shell)), "en");
      expect(markup, shell).toContain('id="main"');
    }
  });

  it("unknown shell calls notFound", async () => {
    for (const shell of ["nope", "constructor", "__proto__", ""]) {
      await expect(ShellPage(shellProps("bn", shell)), shell).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("admin is not available in web", async () => {
    await expect(ShellPage(shellProps("bn", "admin"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("invalid page falls back to dashboard", async () => {
    for (const page of ["nope", ["wallet", "invoices"], ""]) {
      const markup = html(await ShellPage(shellProps("en", "app", page)), "en");
      expect(markup, String(page)).toMatch(current("app", "dashboard"));
    }
    const wallet = html(await ShellPage(shellProps("en", "app", "wallet")), "en");
    expect(wallet).toMatch(current("app", "wallet"));
  });
});
