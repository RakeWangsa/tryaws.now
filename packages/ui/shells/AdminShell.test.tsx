// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { unknownClasses } from "../test/render.tsx";
import type { Locale } from "../runtime/index.ts";
import { AdminShell, type AdminShellProps } from "./AdminShell.tsx";
import { shellMessages } from "./messages/index.ts";
import { ADMIN_NAV } from "./nav.ts";
import { withIntl } from "./test-utils.tsx";

const LOCALES: readonly Locale[] = ["bn", "en"];

function shell(locale: Locale, extra: Partial<AdminShellProps> = {}) {
  const props: AdminShellProps = {
    locale,
    localeHrefs: { bn: "/", en: "/en" },
    currentId: "today",
    admin: { displayName: "Karim", role: "finance" },
    visibleIds: null,
    children: <p id="page">Page</p>,
    ...extra,
  };
  return withIntl(<AdminShell {...props} />, locale);
}

type Admin = {
  ops: string;
  signedInAs: string;
  roles: Record<string, string>;
  nav: Record<string, string>;
};
const admin = (locale: Locale): Admin => (shellMessages[locale].Shell as { admin: Admin }).admin;

describe.each(LOCALES)("AdminShell (%s)", (locale) => {
  it("shows the OPS label", () => {
    const { container } = render(shell(locale));
    const label = container.querySelector("header span.tc-ops-label") as Element;
    expect(label.textContent).toBe(admin(locale).ops);
  });

  it("uses the admin nav labels and hrefs of 16.12", () => {
    const { container } = render(shell(locale));
    const links = [...container.querySelectorAll("#sidebar a")];
    expect(links.map((a) => a.textContent?.trim())).toEqual(
      ADMIN_NAV.map((entry) => admin(locale).nav[entry.id]),
    );
    const prefix = locale === "en" ? "/en" : "";
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      ADMIN_NAV.map((entry) => (entry.href === "/" ? prefix || "/" : `${prefix}${entry.href}`)),
    );
    expect(container.querySelector("#sidebar a[aria-current='page']")?.textContent?.trim()).toBe(
      admin(locale).nav.today,
    );
  });

  it("visibleIds hides the others", () => {
    const { container } = render(shell(locale, { visibleIds: ["today", "payments"] }));
    expect([...container.querySelectorAll("#sidebar a")].map((a) => a.textContent?.trim())).toEqual(
      [admin(locale).nav.today, admin(locale).nav.payments],
    );
  });

  it("navHref overrides the href of every entry", () => {
    const { container } = render(shell(locale, { navHref: (id) => `/a/${id}` }));
    expect(container.querySelector("#sidebar a")?.getAttribute("href")).toBe("/a/today");
  });

  it("has no WalletChip and no bell", () => {
    const { container } = render(shell(locale));
    expect(container.querySelector(".tc-wallet-chip")).toBeNull();
    expect(container.querySelector("a[href$='/notifications']")).toBeNull();
    expect(container.querySelector("i.fa-bell")).toBeNull();
    expect(container.querySelector(".toplang")).not.toBeNull();
  });

  it("the account menu shows the name and the role label", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup();
    const { container, findByRole } = render(shell(locale));
    const trigger = container.querySelector("header button[aria-haspopup='menu']") as HTMLElement;
    await user.click(trigger);
    const list = await findByRole("menu");
    expect(list.textContent).toContain("Karim");
    expect(list.textContent).toContain(
      `${admin(locale).signedInAs} ${admin(locale).roles.finance}`,
    );
  });

  it("does not include any customer nav label", () => {
    const { container } = render(shell(locale));
    const customer = (shellMessages[locale].Shell as { nav: Record<string, string> }).nav;
    const text = container.querySelector("#sidebar")?.textContent ?? "";
    // "support" is a label of both navigations; every other customer label must be absent.
    for (const [id, label] of Object.entries(customer)) {
      if (id === "support" || Object.values(admin(locale).nav).includes(label)) continue;
      expect(text, id).not.toContain(label);
    }
    expect(text).not.toContain(customer.cloudServers);
  });

  it("has the main landmark, a skip link and the admin nav label", () => {
    const { container } = render(shell(locale));
    expect(container.querySelectorAll("main#main")).toHaveLength(1);
    expect(container.querySelector("a.tc-skip-link[href='#main']")).not.toBeNull();
    const shellText = (shellMessages[locale].Shell as { admin: { navLabel: string } }).admin
      .navLabel;
    expect(container.querySelector(`#sidebar nav[aria-label='${shellText}']`)).not.toBeNull();
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
});
