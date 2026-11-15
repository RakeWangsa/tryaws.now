// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Locale } from "../runtime/index.ts";
import { localeHrefs } from "../runtime/index.ts";
import { AdminShell } from "./AdminShell.tsx";
import { AppShell } from "./AppShell.tsx";
import { AuthShell } from "./AuthShell.tsx";
import { PublicShell } from "./PublicShell.tsx";
import { withIntl } from "./test-utils.tsx";

// WPU-X19 (owner, 2026-11-15): only the home page is bilingual, so only the home page has the
// language switch (the pills of the mockup). A shell shows the switch exactly when it is given hrefs.

const LOCALES: readonly Locale[] = ["bn", "en"];

function pub(locale: Locale, withHrefs: boolean) {
  return render(
    withIntl(
      <PublicShell
        locale={locale}
        {...(withHrefs ? { localeHrefs: localeHrefs("/") } : {})}
        signedIn={false}
        openFamilies={["cloudServers"]}
        domainsOpen
        announcement={null}
        supportPhone={null}
      >
        <p>body</p>
      </PublicShell>,
      locale,
    ),
  );
}

describe("the language switch is on the home page only (WPU-X19)", () => {
  it("PublicShell: shown with hrefs (menu and mobile menu), absent without", () => {
    for (const locale of LOCALES) {
      const on = pub(locale, true);
      expect(on.container.querySelectorAll("a[hreflang]").length, locale).toBeGreaterThanOrEqual(2);
      on.unmount();
      const off = pub(locale, false);
      expect(off.container.querySelector("a[hreflang]"), locale).toBeNull();
      expect(off.container.querySelector(".tc-locale-switch"), locale).toBeNull();
      off.unmount();
    }
  });

  it("the home switch links bn to / and en to /en", () => {
    const { container } = pub("bn", true);
    const hrefs = [...container.querySelectorAll("a[hreflang]")].map((a) => [
      a.getAttribute("hreflang"),
      a.getAttribute("href"),
    ]);
    expect(hrefs).toContainEqual(["bn", "/"]);
    expect(hrefs).toContainEqual(["en", "/en"]);
  });

  it("every link that leaves the Bengali home page goes to the English page", () => {
    const { container } = pub("bn", true);
    const own = [...container.querySelectorAll("a[href]:not([hreflang])")]
      .map((a) => a.getAttribute("href") as string)
      .filter((href) => href.startsWith("/"));
    expect(own.length).toBeGreaterThan(5);
    for (const href of own) expect(href === "/" || href.startsWith("/en/"), href).toBe(true);
  });

  it("AuthShell: no switch without hrefs", () => {
    for (const locale of LOCALES) {
      const { container, unmount } = render(
        withIntl(
          <AuthShell locale={locale}>
            <p id="card-body">form</p>
          </AuthShell>,
          locale,
        ),
      );
      expect(container.querySelector(".tc-auth-lang")).toBeNull();
      expect(container.querySelector("a[hreflang]")).toBeNull();
      expect(container.querySelector("#card-body")).not.toBeNull();
      unmount();
    }
  });

  it("AppShell and AdminShell: no switch without hrefs", () => {
    for (const locale of LOCALES) {
      const app = render(
        withIntl(
          <AppShell
            locale={locale}
            currentId="dashboard"
            user={{ displayName: "Rahim" }}
            balanceMinor={0n}
            enabledFamilies={["cloudServers"]}
          >
            <p>x</p>
          </AppShell>,
          locale,
        ),
      );
      expect(app.container.querySelector(".toplang"), locale).toBeNull();
      app.unmount();
      const admin = render(
        withIntl(
          <AdminShell
            locale={locale}
            currentId="today"
            admin={{ displayName: "Karim", role: "finance" }}
            visibleIds={null}
          >
            <p>x</p>
          </AdminShell>,
          locale,
        ),
      );
      expect(admin.container.querySelector(".toplang"), locale).toBeNull();
      admin.unmount();
    }
  });
});
