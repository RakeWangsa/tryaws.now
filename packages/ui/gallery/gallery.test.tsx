// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as kit from "../index.ts";
import { formatMoney } from "../index.ts";
import { loadKitMessages } from "../messages/index.ts";
import { composeMessages, type Locale, type Messages } from "../runtime/index.ts";
import { shellMessages } from "../shells/messages/index.ts";
import { unknownClasses } from "../test/render.tsx";
import { vendoredThemePresent } from "../theme/present.ts";
import { themeAttributes } from "../theme/public.ts";
import { KitGallery } from "./KitGallery.tsx";
import { galleryMessages } from "./messages/index.ts";

// Visual exports of the barrel that the gallery does not show as a sample on purpose. Each one is
// a page frame or a part of one; /dev/ui/[shell] shows it (ShellDemo.test.tsx proves that).
const NOT_VISUAL: readonly string[] = [
  "PublicShell", // frame of /dev/ui/public
  "AuthShell", // frame of /dev/ui/auth
  "AppShell", // frame of /dev/ui/app
  "AdminShell", // frame of /dev/ui/admin
  "MobileMenu", // the phone bar inside PublicShell
];

const LOCALES: readonly Locale[] = ["bn", "en"];

function messagesOf(locale: Locale): Messages {
  return composeMessages(
    loadKitMessages(locale) as Messages,
    shellMessages[locale],
    galleryMessages[locale],
  );
}

function inProvider(node: ReactElement, locale: Locale): ReactElement {
  return (
    <NextIntlClientProvider locale={locale} messages={messagesOf(locale)} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>
  );
}

function html(locale: Locale, app: "web" | "admin" = "web"): string {
  return renderToStaticMarkup(inProvider(<KitGallery app={app} />, locale));
}

function dom(locale: Locale, app: "web" | "admin" = "web"): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html(locale, app);
  return root;
}

const here = dirname(fileURLToPath(import.meta.url));

describe("KitGallery", () => {
  it("every visual export of the kit has a data-gallery marker", () => {
    const exported = Object.entries(kit as Record<string, unknown>)
      .filter(([name, value]) => /^[A-Z][A-Za-z0-9]*$/.test(name) && typeof value === "function")
      .map(([name]) => name)
      .filter((name) => !NOT_VISUAL.includes(name));
    expect(exported.length).toBeGreaterThan(25);
    for (const locale of LOCALES) {
      const marked = new Set(
        [...dom(locale).querySelectorAll("[data-gallery]")].map((el) =>
          el.getAttribute("data-gallery"),
        ),
      );
      const missing = exported.filter((name) => !marked.has(name));
      expect(missing, `no sample for: ${missing.join(", ")} (${locale})`).toEqual([]);
    }
  });

  it("has the eight groups in the order of 16.6, each with its own samples", () => {
    const root = dom("en");
    const groups = [...root.querySelectorAll("section[data-gallery-group]")];
    expect(groups.map((g) => g.getAttribute("data-gallery-group"))).toEqual([
      "surfaces",
      "choices",
      "data",
      "forms",
      "overlays",
      "states",
      "format",
      "aws",
    ]);
    const samples = (group: string): (string | null)[] =>
      [...root.querySelectorAll(`section[data-gallery-group="${group}"] [data-gallery]`)].map(
        (el) => el.getAttribute("data-gallery"),
      );
    expect(samples("surfaces")).toEqual(["Card", "StatTile", "PlanCard", "PlanPicker"]);
    expect(samples("choices")).toEqual([
      "OptionGroup",
      "ImageTile",
      "SummarySidebar",
      "PriceBreakdown",
    ]);
    expect(samples("data")).toEqual(["DataTable", "Tabs", "Accordion"]);
    expect(samples("overlays")).toEqual(["Modal", "ConfirmDestroy", "ToastProvider"]);
  });

  it("gives every sample an h3 title and a caption naming the mockup page and class", () => {
    for (const locale of LOCALES) {
      const root = dom(locale);
      const samples = [...root.querySelectorAll("[data-gallery]")];
      expect(samples.length).toBeGreaterThanOrEqual(30);
      for (const sample of samples) {
        const name = sample.getAttribute("data-gallery");
        const heading = sample.querySelector(":scope > h3");
        expect(heading?.textContent?.trim().length ?? 0, `${name} h3`).toBeGreaterThan(0);
        const caption = sample.querySelector(":scope > p.tc-gallery-source code");
        expect(caption?.textContent?.trim().length ?? 0, `${name} caption`).toBeGreaterThan(4);
      }
      const card = root.querySelector('[data-gallery="Card"] code') as HTMLElement;
      expect(card.textContent).toContain("checkout.html");
      expect(card.textContent).toContain("div.sec-main");
    }
  });

  it("renders in bn and en without throwing, in both apps", () => {
    for (const locale of LOCALES) {
      for (const app of ["web", "admin"] as const) {
        expect(() => html(locale, app), `${app} ${locale}`).not.toThrow();
      }
    }
  });

  it("shows every state of 16.13 with an icon and a text label", () => {
    for (const locale of LOCALES) {
      const root = dom(locale);
      const badges = [...root.querySelectorAll('[data-gallery="StateBadge"] span.badge')];
      // The seven rows of 16.13 hold nine states (the payment row holds three).
      expect(badges.length).toBe(9);
      const kitText = loadKitMessages(locale) as unknown as {
        kit: { state: Record<string, string> };
      };
      const labels = badges.map((badge) => badge.textContent?.trim());
      expect(labels).toEqual(Object.values(kitText.kit.state));
      for (const badge of badges) {
        expect(
          badge.querySelector("i[aria-hidden='true']"),
          badge.textContent ?? "",
        ).not.toBeNull();
      }
      expect(root.querySelectorAll('[data-gallery="Badge"] span.badge').length).toBe(4);
    }
  });

  it("shows the four button variants and a pending button", () => {
    const root = dom("en");
    const buttons = root.querySelectorAll('[data-gallery="Button"] .btn');
    const classes = [...buttons].map((button) => button.className);
    for (const wanted of [
      "btn-default-yellow-fill",
      "btn-default-pink-fill",
      "btn-default-pink",
      "btn-danger",
    ]) {
      expect(
        classes.some((c) => c.includes(wanted)),
        wanted,
      ).toBe(true);
    }
    expect(root.querySelector('[data-gallery="Button"] button[aria-busy="true"]')).not.toBeNull();
  });

  it("the Aws section shows Aws.short, Aws.long and the trademark line unchanged", () => {
    for (const locale of LOCALES) {
      const aws = shellMessages[locale]["Aws"] as unknown as Record<string, string>;
      const section = dom(locale).querySelector('section[data-gallery-group="aws"]') as HTMLElement;
      const text = section.textContent ?? "";
      expect(text, locale).toContain(aws["short"]);
      expect(text, locale).toContain(aws["long"]);
      expect(text, locale).toContain(aws["trademark"]);
    }
  });

  it("the Aws section names the products as 16.13 does, in the current locale", () => {
    const en = dom("en").querySelector('[data-gallery="ProductNames"]') as HTMLElement;
    expect(en.textContent).toContain("Cloud Server");
    expect(en.textContent).toContain("Amazon Lightsail instance");
    expect(en.textContent).toContain("Amazon Route 53");
    expect(en.querySelectorAll("tbody tr").length).toBe(15);
    const bn = dom("bn").querySelector('[data-gallery="ProductNames"]') as HTMLElement;
    expect(bn.textContent).toContain("ক্লাউড সার্ভার");
    expect(bn.textContent).toContain("Amazon Lightsail instance");
  });

  it("MoneyText samples show the taka sign and the formatted bigint amounts, never NaN", () => {
    for (const locale of LOCALES) {
      const sample = dom(locale).querySelector('[data-gallery="MoneyText"]') as HTMLElement;
      const text = sample.textContent ?? "";
      expect(text, locale).toContain("৳");
      expect(text, locale).not.toMatch(/NaN|undefined|\[object|Infinity/);
      for (const minor of [0n, 99n, 125050n, 100000000n]) {
        expect(text, `${locale} ${minor}`).toContain(formatMoney(minor, { locale }));
        expect(text, `${locale} ${minor} whole`).toContain(
          formatMoney(minor, { locale, mode: "wholeUp" }),
        );
      }
    }
  });

  it("DateText shows the fixed instant in three variants", () => {
    const sample = dom("en").querySelector('[data-gallery="DateText"]') as HTMLElement;
    const times = [...sample.querySelectorAll("time")];
    expect(times.length).toBe(3);
    for (const time of times)
      expect(time.getAttribute("datetime")).toBe("2026-11-11T04:30:00.000Z");
  });

  it("has no style attribute and no script element in the rendered HTML (U4)", () => {
    for (const locale of LOCALES) {
      for (const app of ["web", "admin"] as const) {
        const markup = html(locale, app);
        expect(markup, `${app} ${locale}`).not.toMatch(/\sstyle\s*=/i);
        expect(markup, `${app} ${locale}`).not.toMatch(/<script/i);
      }
    }
  });

  it.skipIf(!vendoredThemePresent())(
    "uses only classes that a stylesheet of the kit defines, besides the gallery hooks",
    () => {
      const hooks = new Set(["tc-gallery", "tc-gallery-source", "tc-gallery-sample"]);
      for (const locale of LOCALES) {
        const unknown = unknownClasses(html(locale)).filter((name) => !hooks.has(name));
        expect(unknown, locale).toEqual([]);
      }
    },
  );

  it("links to the other locale and to the shell demos of the app", () => {
    const web = dom("bn", "web");
    const hrefs = [...web.querySelectorAll("[data-gallery-nav] a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/en/dev/ui");
    expect(hrefs).toEqual(
      expect.arrayContaining(["/en/dev/ui/public", "/en/dev/ui/auth", "/en/dev/ui/app"]),
    );
    expect(hrefs).not.toContain("/en/dev/ui/admin");
    const admin = dom("en", "admin");
    const adminHrefs = [...admin.querySelectorAll("[data-gallery-nav] a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(adminHrefs).toContain("/en/dev/ui");
    expect(adminHrefs).toContain("/en/dev/ui/admin");
    expect(adminHrefs).not.toContain("/en/dev/ui/app");
  });

  it("the attribute switch sets the customer or the admin data attributes on the body", () => {
    const { getByRole, unmount } = render(inProvider(<KitGallery app="web" />, "en"));
    const names = galleryMessages.en["Gallery"] as unknown as {
      attributes: { customer: string; admin: string };
    };
    const adminButton = getByRole("button", { name: names.attributes.admin });
    const customerButton = getByRole("button", { name: names.attributes.customer });
    expect(customerButton.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      fireEvent.click(adminButton);
    });
    for (const [name, value] of Object.entries(themeAttributes("admin"))) {
      expect(document.body.getAttribute(name), name).toBe(value);
    }
    expect(adminButton.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      fireEvent.click(customerButton);
    });
    for (const [name, value] of Object.entries(themeAttributes("web"))) {
      expect(document.body.getAttribute(name), name).toBe(value);
    }
    unmount();
  });

  it("no sample imports or calls fetch, and no gallery source reads process.env", () => {
    const files = [
      ...readdirSync(here).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)),
      ...readdirSync(join(here, "sections")).map((f) => join("sections", f)),
      ...readdirSync(join(here, "messages")).map((f) => join("messages", f)),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/process\.env/);
      expect(source, file).not.toMatch(/@tc\/aws|@aws-sdk/);
      expect(source, file).not.toMatch(/\sstyle=/);
    }
  });

  it("keeps demo text out of the section components: no Bengali letters", () => {
    for (const file of readdirSync(join(here, "sections"))) {
      const source = readFileSync(join(here, "sections", file), "utf8");
      expect(source, file).not.toMatch(/[ঀ-৿]/);
    }
  });
});
