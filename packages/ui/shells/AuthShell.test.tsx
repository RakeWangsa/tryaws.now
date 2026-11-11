// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Locale } from "../runtime/index.ts";
import { localeHrefs } from "../runtime/index.ts";
import { AuthShell } from "./AuthShell.tsx";
import { shellMessages } from "./messages/index.ts";
import { withIntl } from "./test-utils.tsx";

function shell(locale: Locale) {
  return render(
    withIntl(
      <AuthShell locale={locale} localeHrefs={localeHrefs("/login")}>
        <p id="card-body">form</p>
      </AuthShell>,
      locale,
    ),
  );
}

describe.each(["bn", "en"] as const)("AuthShell (%s)", (locale) => {
  const shellText = shellMessages[locale]["Shell"] as unknown as {
    logoAlt: string;
    auth: { backHome: string };
  };
  const aws = shellMessages[locale]["Aws"] as unknown as Record<string, string>;

  it("renders the logo twice (d-block, d-none) with alt text", () => {
    const { container } = shell(locale);
    const block = container.querySelector("img.svg.logo-menu.d-block");
    const none = container.querySelector("img.svg.logo-menu.d-none");
    expect(block?.getAttribute("src")).toBe("/brand/logo.svg");
    expect(none?.getAttribute("src")).toBe("/brand/logo-light.svg");
    expect(block?.getAttribute("alt")).toBe(shellText.logoAlt);
    expect(none?.getAttribute("alt")).toBe(shellText.logoAlt);
    expect(block?.getAttribute("width")).toBe("200");
    expect(block?.getAttribute("height")).toBe("50");
  });

  it("wraps children in the card of the mockup", () => {
    const { container } = shell(locale);
    expect(
      container.querySelector(
        "div.fullrock.config.sec-bg3.motpath.bg-colorstyle > section.fullrock-content > div.container",
      ),
    ).not.toBeNull();
    const card = container.querySelector(
      "main#main > div.sec-main.sec-bg1.tabs.bg-seccolorstyle.noshadow",
    );
    expect(card?.querySelector("#card-body")).not.toBeNull();
  });

  it("has a LocaleSwitch and the back link", () => {
    const { container } = shell(locale);
    expect(container.querySelectorAll(".tc-auth-lang a[hreflang]")).toHaveLength(2);
    const back = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === shellText.auth.backHome,
    );
    expect(back?.getAttribute("href")).toBe(locale === "en" ? "/en" : "/");
  });

  it("holds Aws.short and the trademark line", () => {
    const { container } = shell(locale);
    const paragraphs = [...container.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toContain(aws["short"]);
    expect(paragraphs).toContain(aws["trademark"]);
  });

  it("has one main landmark and no style attribute or script", () => {
    const { container } = shell(locale);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});
