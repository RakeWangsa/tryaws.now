// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { HelpStrip } from "./HelpStrip";
import type { LinkComponent } from "./types";

const items = [
  { href: "/support", title: "Support", description: "Open a ticket.", icon: "fas fa-headset" },
  { href: "/docs", title: "Guides", description: "Read the guides.", icon: "fas fa-book" },
  { href: "/contact", title: "Contact", description: "Write to us.", icon: "fas fa-envelope" },
];

describe("HelpStrip", () => {
  it("renders one card per item with the markup of index.html", () => {
    const { container } = renderKit(<HelpStrip items={items} />);
    const section = container.firstElementChild as HTMLElement;
    expect(section.tagName).toBe("SECTION");
    for (const name of ["services", "help", "pt-4"]) {
      expect(section.classList.contains(name), name).toBe(true);
    }
    const cols = section.querySelectorAll(".service-wrap > .row > div.col-sm-12.col-md-6.col-lg-4");
    expect(cols.length).toBe(3);
    const links = container.querySelectorAll("div.help-container.bg-seccolorstyle > a.help-item");
    expect([...links].map((a) => a.getAttribute("href"))).toEqual([
      "/support",
      "/docs",
      "/contact",
    ]);
    const first = links[0] as HTMLElement;
    expect(first.querySelector("div.img > i")?.getAttribute("aria-hidden")).toBe("true");
    expect(first.querySelector("div.inform > div.title.mergecolor")?.textContent).toBe("Support");
    expect(first.querySelector("div.inform > div.description.seccolor")?.textContent).toBe(
      "Open a ticket.",
    );
  });

  it("puts the icon classes on the i element", () => {
    const { container } = renderKit(<HelpStrip items={items} />);
    const icon = container.querySelector("a.help-item i") as HTMLElement;
    expect(icon.classList.contains("fas")).toBe(true);
    expect(icon.classList.contains("fa-headset")).toBe(true);
  });

  it("uses linkAs for every link", () => {
    const Marked: LinkComponent = ({ href, className, children }) => (
      <a href={href} className={className} data-marked="1">
        {children as ReactNode}
      </a>
    );
    const { container } = renderKit(<HelpStrip items={items} linkAs={Marked} />);
    expect(container.querySelectorAll("a.help-item[data-marked]").length).toBe(3);
  });

  it("throws for empty items (R16)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => renderKit(<HelpStrip items={[]} />)).toThrow(RangeError);
    } finally {
      spy.mockRestore();
    }
  });

  it("has no img", () => {
    const { container } = renderKit(<HelpStrip items={items} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses only known classes and no inline style, in both locales", () => {
    for (const locale of ["bn", "en"] as const) {
      const { container, unmount } = renderKit(<HelpStrip items={items} />, { locale });
      expect(unknownClasses(container)).toEqual([]);
      unmount();
    }
    expect(ssr(<HelpStrip items={items} />)).not.toContain(" style=");
  });
});
