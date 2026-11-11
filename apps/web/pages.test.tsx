import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { THEME_STYLESHEETS, fontPreloads } from "@tc/ui/theme";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "./i18n/messages.ts";

// `next-intl/server` reads the request; the tests give it a locale and the real messages.
const state = vi.hoisted(() => ({ locale: "bn" as "bn" | "en", nonce: "n0nce" as string | null }));

vi.mock("next-intl/server", async () => {
  const { webMessages: messages } = await import("./i18n/messages.ts");
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
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.nonce === null ? {} : { "x-nonce": state.nonce }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { default: RootLayout, dynamic } = await import("./app/layout.tsx");
const { default: LocaleLayout } = await import("./app/[locale]/layout.tsx");
const { default: HomePage, generateMetadata } = await import("./app/[locale]/page.tsx");
const { default: NotFound } = await import("./app/not-found.tsx");

function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

function shortSentence(locale: Locale): string {
  const aws = webMessages[locale]["Aws"] as { short: string };
  return aws.short;
}

beforeEach(() => {
  state.locale = "bn";
  state.nonce = "n0nce";
});

describe("landing page", () => {
  it("renders the Aws.short sentence in bn and en", async () => {
    for (const locale of ["bn", "en"] as const) {
      state.locale = locale;
      const html = intl(await HomePage({ params: Promise.resolve({ locale }) }), locale);
      expect(html, locale).toContain(shortSentence(locale));
    }
  });

  it("has one h1 title and the announcement in the top line", async () => {
    for (const locale of ["bn", "en"] as const) {
      state.locale = locale;
      const html = intl(await HomePage({ params: Promise.resolve({ locale }) }), locale);
      const web = webMessages[locale]["Web"] as { announcement: string; home: { title: string } };
      expect(html.match(/<h[1-6][ >]/g), locale).toEqual(["<h1 "]);
      expect(html, locale).toContain(`<h1 class="h4 mergecolor">${web.home.title}</h1>`);
      expect(html, locale).toContain(`<div class="col-6 col-md-7 news"><span>${web.announcement}`);
    }
  });

  it("follows the mockup: a section.sec-normal with a container, in the main landmark", async () => {
    const html = intl(await HomePage({ params: Promise.resolve({ locale: "bn" }) }), "bn");
    expect(html).toContain(
      '<main id="main"><section class="sec-normal notfound"><div class="container">',
    );
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<script");
  });

  it("links the language switch to / and /en", async () => {
    const html = intl(await HomePage({ params: Promise.resolve({ locale: "bn" }) }), "bn");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/en"');
  });

  it("calls notFound for an unknown locale", async () => {
    await expect(HomePage({ params: Promise.resolve({ locale: "fr" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("gives the title, description and icon as metadata", async () => {
    state.locale = "en";
    const meta = await generateMetadata({ params: Promise.resolve({ locale: "en" }) });
    const web = webMessages.en["Web"] as { meta: { title: string; description: string } };
    expect(meta).toEqual({
      title: web.meta.title,
      description: web.meta.description,
      icons: { icon: "/brand/symbol.svg" },
    });
  });
});

describe("not-found page", () => {
  it("has the title and a link to the localized home, in bn and en", async () => {
    for (const locale of ["bn", "en"] as const) {
      state.locale = locale;
      const html = intl(await NotFound(), locale);
      const shell = webMessages[locale]["Shell"] as {
        notFound: { title: string; body: string };
        auth: { backHome: string };
      };
      expect(html, locale).toContain(`<h1 class="h4 mergecolor">${shell.notFound.title}</h1>`);
      expect(html, locale).toContain(shell.notFound.body);
      const home = locale === "bn" ? "/" : "/en";
      expect(html, locale).toContain(
        `<a href="${home}" class="btn btn-default-yellow-fill">${shell.auth.backHome}</a>`,
      );
    }
  });
});

describe("locale layout", () => {
  it("returns the children for bn and en", async () => {
    for (const locale of ["bn", "en"] as const) {
      const element = await LocaleLayout({
        children: <p>child</p>,
        params: Promise.resolve({ locale }),
      });
      expect(renderToStaticMarkup(element), locale).toBe("<p>child</p>");
    }
  });

  it("calls notFound for an unknown locale", async () => {
    await expect(
      LocaleLayout({ children: <p>child</p>, params: Promise.resolve({ locale: "fr" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("root layout", () => {
  it("is dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("sets lang, body attributes, one content div, stylesheets and font preloads", async () => {
    for (const locale of ["bn", "en"] as const) {
      state.locale = locale;
      const html = renderToStaticMarkup(await RootLayout({ children: <p>child</p> }));
      expect(html, locale).toContain(`<html lang="${locale}">`);
      for (const attr of [
        'data-layout="wide"',
        'data-color="pink"',
        'data-background="dark"',
        'data-font="opensans"',
        'data-header="static"',
        'data-radius="defaultradius"',
        'data-textdirection="ltr"',
      ]) {
        expect(html, `${locale} ${attr}`).toContain(attr);
      }
      expect(html.match(/<div class="box-container limit-width">/g), locale).toHaveLength(1);
      expect(html, locale).toContain('<div class="box-container limit-width"><p>child</p></div>');

      const sheets = THEME_STYLESHEETS.map((href) =>
        html.indexOf(`<link rel="stylesheet" href="${href}"`),
      );
      expect(
        sheets.every((i) => i >= 0),
        locale,
      ).toBe(true);
      expect(
        [...sheets].sort((a, b) => a - b),
        locale,
      ).toEqual(sheets);

      const fonts = fontPreloads(locale);
      expect(html.match(/<link rel="preload"/g), locale).toHaveLength(fonts.length);
      for (const font of fonts) {
        expect(html, locale).toContain(
          `<link rel="preload" href="${font.href}" as="font" type="font/woff2" crossorigin="anonymous"/>`,
        );
      }
    }
  });

  it("holds no inline style and no inline script of its own", async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: null }));
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<script");
  });
});
