// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { loadKitMessages } from "../messages/index.ts";
import { composeMessages, type Locale, type Messages } from "../runtime/index.ts";
import { shellMessages } from "../shells/messages/index.ts";
import { GALLERY_SHELLS, resolveGalleryShell } from "./index.ts";
import { galleryMessages } from "./messages/index.ts";
import { ShellDemo } from "./ShellDemo.tsx";

function demo(element: ReactElement, locale: Locale) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={composeMessages(
        loadKitMessages(locale) as Messages,
        shellMessages[locale],
        galleryMessages[locale],
      )}
      timeZone="Asia/Dhaka"
    >
      {element}
    </NextIntlClientProvider>,
  );
}

const current = (container: HTMLElement): string | null =>
  container.querySelector("nav a[aria-current]")?.getAttribute("href") ?? null;

describe("GALLERY_SHELLS", () => {
  it("lists the shells of each app", () => {
    expect(GALLERY_SHELLS.web).toEqual(["public", "auth", "app"]);
    expect(GALLERY_SHELLS.admin).toEqual(["admin"]);
  });

  it("resolveGalleryShell accepts only the shells of the app", () => {
    expect(resolveGalleryShell("web", "app")).toBe("app");
    expect(resolveGalleryShell("web", "admin")).toBeNull();
    expect(resolveGalleryShell("admin", "admin")).toBe("admin");
    expect(resolveGalleryShell("admin", "app")).toBeNull();
    expect(resolveGalleryShell("web", "constructor")).toBeNull();
  });
});

describe.each(["bn", "en"] as const)("ShellDemo (%s)", (locale) => {
  const prefix = locale === "en" ? "/en" : "";
  const user = (galleryMessages[locale]["Gallery"] as unknown as { demo: { user: string } }).demo
    .user;

  it("public: PublicShell with the families open, the announcement and sample content", () => {
    const { container } = demo(<ShellDemo shell="public" locale={locale} />, locale);
    const text = container.textContent ?? "";
    expect(container.querySelector("main#main")).not.toBeNull();
    expect(container.querySelector("a[href$='/products/cloud-servers']")).not.toBeNull();
    expect(container.querySelector("a[href$='/products/domains']")).not.toBeNull();
    const gallery = galleryMessages[locale]["Gallery"] as unknown as {
      demo: { announcement: string };
    };
    expect(text).toContain(gallery.demo.announcement);
    expect(container.querySelector("[data-gallery='ShellContent']")).not.toBeNull();
  });

  it("auth: AuthShell with two kit Tabs and a Field pair", () => {
    const { container } = demo(<ShellDemo shell="auth" locale={locale} />, locale);
    expect(container.querySelectorAll("[role=tab]").length).toBe(2);
    expect(container.querySelectorAll("input").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector("#main .sec-main")).not.toBeNull();
  });

  it("app: AppShell with the demo user, the balance, the bell count and containers as soon", async () => {
    const { container } = demo(<ShellDemo shell="app" locale={locale} />, locale);
    const account = (shellMessages[locale]["Shell"] as unknown as { app: { account: string } }).app
      .account;
    await userEvent.click(screen.getByRole("button", { name: account }));
    expect(document.body.textContent).toContain(user);
    expect(container.textContent).toContain("৳");
    expect(current(container)).toBe(`${prefix}/dev/ui/app?page=dashboard`);
    const soon = (shellMessages[locale]["Shell"] as unknown as { app: { soon: string } }).app.soon;
    const badges = [...container.querySelectorAll("nav .badge")].map((badge) => badge.textContent);
    expect(badges, "containers is listed as soon, without a link").toEqual([soon]);
    expect(container.querySelector("a[href$='?page=containers']")).toBeNull();
    expect(container.querySelector("a[aria-label] .badge")?.textContent).toMatch(/3|৩/);
  });

  it("app: ?page selects the entry; an invalid page falls back to dashboard", () => {
    const wallet = demo(<ShellDemo shell="app" locale={locale} page="wallet" />, locale);
    expect(current(wallet.container)).toBe(`${prefix}/dev/ui/app?page=wallet`);
    wallet.unmount();
    for (const bad of ["nope", "__proto__", "", "dashboard&x=1", "../etc"]) {
      const view = demo(<ShellDemo shell="app" locale={locale} page={bad} />, locale);
      expect(current(view.container), JSON.stringify(bad)).toBe(
        `${prefix}/dev/ui/app?page=dashboard`,
      );
      view.unmount();
    }
  });

  it("admin: AdminShell with the OPS label; an invalid page falls back to today", () => {
    const view = demo(<ShellDemo shell="admin" locale={locale} page="nope" />, locale);
    expect(view.container.querySelector(".tc-ops-label")).not.toBeNull();
    expect(current(view.container)).toBe(`${prefix}/dev/ui/admin?page=today`);
    view.unmount();
    const audit = demo(<ShellDemo shell="admin" locale={locale} page="audit" />, locale);
    expect(current(audit.container)).toBe(`${prefix}/dev/ui/admin?page=audit`);
  });

  it("writes no style attribute and no script element", () => {
    for (const shell of ["public", "auth", "app", "admin"] as const) {
      const { container, unmount } = demo(<ShellDemo shell={shell} locale={locale} />, locale);
      expect(container.innerHTML, shell).not.toMatch(/\sstyle\s*=/i);
      expect(container.innerHTML, shell).not.toMatch(/<script/i);
      unmount();
    }
  });
});
