// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Locale } from "../../runtime/index.ts";
import { shellMessages } from "../messages/index.ts";
import { withIntl } from "../test-utils.tsx";
import { CREDIT_URL, CreditLine } from "./CreditLine.tsx";

describe.each(["bn", "en"] as const)("CreditLine (%s)", (locale: Locale) => {
  const text = shellMessages[locale]["Shell"] as unknown as {
    credit: { text: string; link: string };
  };

  it("shows the credit text and one safe link to the author's LinkedIn profile", () => {
    const { container } = render(withIntl(<CreditLine />, locale));
    expect(container.textContent).toContain(text.credit.text);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://www.linkedin.com/in/in-moshiur");
    expect(links[0]?.getAttribute("href")).toBe(CREDIT_URL);
    expect(links[0]?.textContent).toBe(text.credit.link);
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
    expect(links[0]?.getAttribute("rel")).toContain("noreferrer");
    expect(container.querySelector("[style]")).toBeNull();
  });
});
