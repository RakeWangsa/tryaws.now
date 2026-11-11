// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { LocaleSwitch } from "./LocaleSwitch";
import type { LinkComponent } from "./types";

const ITEMS = [
  { locale: "bn", href: "/bn/billing" },
  { locale: "en", href: "/en/billing" },
] as const;

const links = (root: Element): HTMLAnchorElement[] => [...root.querySelectorAll("a")];

describe("LocaleSwitch", () => {
  it("renders the group of the mockup with two links", () => {
    const { container } = renderKit(<LocaleSwitch current="bn" items={[...ITEMS]} />, {
      locale: "en",
    });
    const group = container.firstElementChild as HTMLElement;
    expect(group.tagName).toBe("DIV");
    expect(group.classList.contains("btn-group")).toBe(true);
    expect(group.classList.contains("btn-group-toggle")).toBe(true);
    expect(group.classList.contains("toplang")).toBe(true);
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Language");
    const [bn, en] = links(container);
    expect(bn?.getAttribute("href")).toBe("/bn/billing");
    expect(bn?.getAttribute("hreflang")).toBe("bn");
    expect(bn?.getAttribute("lang")).toBe("bn");
    expect(en?.getAttribute("href")).toBe("/en/billing");
    expect(en?.getAttribute("hreflang")).toBe("en");
    expect(en?.getAttribute("lang")).toBe("en");
    for (const a of links(container)) {
      expect(a.classList.contains("btn")).toBe(true);
      expect(a.classList.contains("btn-secondary")).toBe(true);
    }
    expect(unknownClasses(container)).toEqual([]);
  });

  it("exactly one link is active and aria-current", () => {
    const { container } = renderKit(<LocaleSwitch current="en" items={[...ITEMS]} />);
    const [bn, en] = links(container);
    expect(bn?.classList.contains("active")).toBe(false);
    expect(bn?.hasAttribute("aria-current")).toBe(false);
    expect(en?.classList.contains("active")).toBe(true);
    expect(en?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelectorAll(".active")).toHaveLength(1);
    expect(container.querySelectorAll("[aria-current]")).toHaveLength(1);
  });

  it("the link texts are the native names in both page locales", () => {
    for (const locale of ["bn", "en"] as const) {
      const { container, unmount } = renderKit(<LocaleSwitch current="bn" items={[...ITEMS]} />, {
        locale,
      });
      expect(links(container).map((a) => a.textContent)).toEqual(["বাংলা", "English"]);
      unmount();
    }
  });

  it("the group label follows the page locale", () => {
    const { container } = renderKit(<LocaleSwitch current="bn" items={[...ITEMS]} />);
    expect(container.firstElementChild?.getAttribute("aria-label")).toBe("ভাষা");
  });

  it("the markup structure is the same in bn and en", () => {
    const shape = (html: string): string =>
      html.replace(/aria-label="[^"]*"/g, "").replace(/>[^<]+</g, "><");
    expect(shape(ssr(<LocaleSwitch current="bn" items={[...ITEMS]} />, { locale: "bn" }))).toBe(
      shape(ssr(<LocaleSwitch current="bn" items={[...ITEMS]} />, { locale: "en" })),
    );
  });

  it("a missing, duplicate or unknown locale throws RangeError", () => {
    expect(() => renderKit(<LocaleSwitch current="bn" items={[ITEMS[0]]} />)).toThrow(RangeError);
    expect(() =>
      renderKit(
        <LocaleSwitch
          current="bn"
          items={[
            { locale: "bn", href: "/a" },
            { locale: "bn", href: "/b" },
          ]}
        />,
      ),
    ).toThrow(RangeError);
    expect(() =>
      renderKit(
        <LocaleSwitch current="bn" items={[ITEMS[0], ITEMS[1], { locale: "en", href: "/c" }]} />,
      ),
    ).toThrow(RangeError);
  });

  it("uses linkAs and gives it the locale attributes", () => {
    const seen: Record<string, unknown>[] = [];
    const Custom = ((props: Record<string, unknown>) => {
      seen.push(props);
      return <a data-custom="1" href={props["href"] as string} />;
    }) as unknown as LinkComponent;
    const { container } = renderKit(
      <LocaleSwitch current="en" items={[...ITEMS]} linkAs={Custom} />,
    );
    expect(container.querySelectorAll("a[data-custom]")).toHaveLength(2);
    expect(seen[0]).toMatchObject({ href: "/bn/billing", hrefLang: "bn", lang: "bn" });
    expect(seen[1]).toMatchObject({ href: "/en/billing", "aria-current": "true" });
    expect(String(seen[1]?.["className"])).toContain("active");
  });
});
