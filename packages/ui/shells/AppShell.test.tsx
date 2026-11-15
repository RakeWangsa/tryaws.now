// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WalletChip } from "../components/WalletChip.tsx";
import { unknownClasses } from "../test/render.tsx";
import type { Locale } from "../runtime/index.ts";
import { AppShell, type AppShellProps } from "./AppShell.tsx";
import { shellMessages } from "./messages/index.ts";
import { APP_NAV } from "./nav.ts";
import type { AppNavId, ProductFamily } from "./types.ts";
import { withIntl } from "./test-utils.tsx";

const LOCALES: readonly Locale[] = ["bn", "en"];
const FAMILIES: readonly ProductFamily[] = [
  "cloudServers",
  "databases",
  "objectStorage",
  "loadBalancers",
  "containers",
  "cdn",
  "domains",
];

function props(locale: Locale, extra: Partial<AppShellProps> = {}): AppShellProps {
  return {
    locale,
    localeHrefs:
      locale === "bn"
        ? { bn: "/servers", en: "/en/servers" }
        : { bn: "/servers", en: "/en/servers" },
    currentId: "dashboard",
    user: { displayName: "Rahim Uddin" },
    balanceMinor: 123456n,
    enabledFamilies: FAMILIES,
    children: <p id="page">Page</p>,
    ...extra,
  };
}

function shell(locale: Locale, extra: Partial<AppShellProps> = {}) {
  return withIntl(<AppShell {...props(locale, extra)} />, locale);
}

function labelOf(locale: Locale, id: AppNavId): string {
  const nav = (shellMessages[locale].Shell as { nav: Record<string, string> }).nav;
  return nav[id] as string;
}

function sidebarRows(container: Element): Element[] {
  return [...container.querySelectorAll("#sidebar nav .heading")];
}

describe.each(LOCALES)("AppShell (%s)", (locale) => {
  it("sidebar lists the twelve entries when all families are enabled, in the order of 16.7", () => {
    const { container } = render(shell(locale));
    const rows = sidebarRows(container);
    expect(rows.map((row) => row.textContent?.trim())).toEqual(
      APP_NAV.map((entry) => labelOf(locale, entry.id)),
    );
    expect(rows).toHaveLength(12);
  });

  it("a family that is not enabled is hidden", () => {
    const { container } = render(shell(locale, { enabledFamilies: ["cloudServers", "domains"] }));
    const text = sidebarRows(container).map((row) => row.textContent?.trim());
    expect(text).not.toContain(labelOf(locale, "databases"));
    expect(text).not.toContain(labelOf(locale, "cdn"));
    expect(text).toContain(labelOf(locale, "cloudServers"));
    expect(sidebarRows(container)).toHaveLength(7);
  });

  it("a soon family shows the Soon badge and is not a link", () => {
    const { container } = render(
      shell(locale, { enabledFamilies: ["cloudServers"], soonFamilies: ["databases"] }),
    );
    const soon = (shellMessages[locale].Shell as { app: { soon: string } }).app.soon;
    const row = sidebarRows(container).find((r) =>
      r.textContent?.includes(labelOf(locale, "databases")),
    ) as Element;
    expect(row.querySelector("a")).toBeNull();
    expect(row.querySelector("span[aria-disabled='true']")).not.toBeNull();
    expect(row.querySelector("span.badge.bg-grey.ms-2")?.textContent).toBe(soon);
  });

  it("the current entry has aria-current=page and a trailing angle icon", () => {
    const { container } = render(shell(locale, { currentId: "wallet" }));
    const current = container.querySelectorAll("#sidebar a[aria-current='page']");
    expect(current).toHaveLength(1);
    const link = current[0] as Element;
    expect(link.classList.contains("active")).toBe(true);
    expect(link.textContent?.trim()).toBe(labelOf(locale, "wallet"));
    expect(link.querySelector("i.fas.fa-angle-right[aria-hidden='true']")).not.toBeNull();
    expect(container.querySelectorAll("#sidebar i.fa-angle-right")).toHaveLength(1);
  });

  it("default hrefs are localized", () => {
    const { container } = render(shell(locale));
    const href = container.querySelector("#sidebar a[href$='/servers']")?.getAttribute("href");
    expect(href).toBe("/en/servers"); // WPU-X19
    const settings = container.querySelector("#sidebar a[href$='/settings/profile']");
    expect(settings?.getAttribute("href")).toBe("/en/settings/profile");
  });

  it("navHref overrides the href of every entry", () => {
    const { container } = render(shell(locale, { navHref: (id) => `/x/${id}` }));
    const hrefs = [...container.querySelectorAll("#sidebar a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(APP_NAV.map((entry) => `/x/${entry.id}`));
  });

  it("top bar has LocaleSwitch, WalletChip with balanceMinor, a bell link to /notifications, the account menu", () => {
    const { container } = render(shell(locale));
    const bar = container.querySelector("header.menu-wrap") as Element;
    expect(bar.querySelector(".toplang")).not.toBeNull();
    const chip = bar.querySelector(".tc-wallet-chip") as Element;
    const alone = render(
      withIntl(<WalletChip balanceMinor={123456n} topUpHref="/wallet" />, locale),
    );
    expect(chip.querySelector("span.mergecolor")?.textContent).toBe(
      alone.container.querySelector("span.mergecolor")?.textContent,
    );
    const prefix = "/en"; // WPU-X19
    expect(chip.querySelector("a")?.getAttribute("href")).toBe(`${prefix}/wallet`);
    const bell = bar.querySelector("a[href$='/notifications']") as Element;
    expect(bell.getAttribute("href")).toBe(`${prefix}/notifications`);
    const notifications = (shellMessages[locale].Shell as { app: { notifications: string } }).app
      .notifications;
    expect(bell.getAttribute("aria-label")).toBe(notifications);
    expect(bell.querySelector("i.fas.fa-bell[aria-hidden='true']")).not.toBeNull();
    const account = (shellMessages[locale].Shell as { app: { account: string } }).app.account;
    const trigger = bar.querySelector(`button[aria-haspopup='menu'][aria-label='${account}']`);
    expect(trigger).not.toBeNull();
  });

  it("unreadCount 0 shows no badge, 3 shows 3", () => {
    const none = render(shell(locale, { unreadCount: 0 }));
    expect(none.container.querySelector("a[href$='/notifications'] .badge")).toBeNull();
    none.unmount();
    const three = render(shell(locale, { unreadCount: 3 }));
    const badge = three.container.querySelector("a[href$='/notifications'] span.badge.bg-pink");
    expect(badge?.textContent).toBe(new Intl.NumberFormat(locale).format(3));
  });

  it("the footer holds Aws.short and the trademark line", () => {
    const { container } = render(shell(locale));
    const footer = container.querySelector("footer.tc-app-footer") as Element;
    const aws = shellMessages[locale].Aws as { short: string; trademark: string };
    expect(footer.textContent).toContain(aws.short);
    expect(footer.textContent).toContain(aws.trademark);
  });

  it("main landmark and skip link exist, in the markup of the mockup", () => {
    const { container } = render(shell(locale));
    expect(container.querySelectorAll("main#main")).toHaveLength(1);
    const first = container.firstElementChild as Element;
    expect(first.matches("a.tc-skip-link[href='#main']")).toBe(true);
    const side = container.querySelector(
      "section.blog.motpath.pb-80.bg-colorstyle div.row > div.col-lg-3.d-none.d-lg-block > aside#sidebar.sidebar.sec-bg1.bg-seccolorstyle.noshadow.tc-app-nav",
    ) as Element;
    expect(side.querySelector("nav[aria-label] > div.menu.categories.clear")).not.toBeNull();
    expect(
      container.querySelector("div.col-lg-9 > div#sidebar_content.wrap-blog > main#main #page"),
    ).not.toBeNull();
    expect(
      container.querySelector(
        "header.menu-wrap > div.nav-menu > div.container-fluid > div.row.align-items-center",
      ),
    ).not.toBeNull();
  });

  it("no style attribute, no script element, no h1, no unknown class", () => {
    const html = renderToStaticMarkup(shell(locale));
    expect(html).not.toMatch(/\sstyle\s*=/);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<h1");
    // `clear` is a hook class of the mockup's sidebar markup; `tc-skip-link` is defined in block 7a.
    const unknown = unknownClasses(html).filter(
      (name) => name !== "clear" && name !== "tc-skip-link",
    );
    expect(unknown).toEqual([]);
  });

  it("the drawer trigger sits in the top bar and the closed drawer is not in the markup", () => {
    const { container } = render(shell(locale));
    const open = (shellMessages[locale].Shell as { app: { openNav: string } }).app.openNav;
    expect(container.querySelector(`header button.d-lg-none[aria-label='${open}']`)).not.toBeNull();
    expect(container.querySelector(".offcanvas")).toBeNull();
  });
});
