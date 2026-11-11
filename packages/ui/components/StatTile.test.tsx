// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("has the classes of the mockup (about.html, clientstats)", () => {
    const { container } = renderKit(<StatTile value="19,322+" description="Active customers" />);
    const root = container.firstElementChild as HTMLElement;
    expect([...root.classList]).toEqual([
      "wrapper",
      "price-container",
      "text-start",
      "bg-seccolorstyle",
      "noshadow",
    ]);
    const top = root.querySelector(":scope > .top-content") as HTMLElement;
    expect(top.classList.contains("pb-5")).toBe(true);
    expect(top.querySelector(".title.mergecolor")?.textContent).toBe("19,322+");
    expect(top.querySelector(".fromer.pt-3.seccolor")?.textContent).toBe("Active customers");
    expect(root.querySelector(".badge")).toBeNull();
    expect(unknownClasses(container)).toEqual([]);
  });

  it("renders the tag before the content with the class of its tone", () => {
    for (const tone of ["purple", "grey", "pink", "dark"] as const) {
      const { container, unmount } = renderKit(
        <StatTile value="9" description="d" tag={{ text: "top", tone }} />,
      );
      const root = container.firstElementChild as HTMLElement;
      const tag = root.firstElementChild as HTMLElement;
      expect([...tag.classList]).toEqual(["plans", "badge", "feat", `bg-${tone}`]);
      expect(tag.tagName).toBe("DIV");
      expect(tag.textContent).toBe("top");
      expect(tag.nextElementSibling?.classList.contains("top-content")).toBe(true);
      expect(unknownClasses(container)).toEqual([]);
      unmount();
    }
  });

  it("renders in bn and en and has no style attribute", () => {
    for (const locale of ["bn", "en"] as const) {
      const html = ssr(<StatTile value="১২" description="গ্রাহক" />, { locale });
      expect(html).not.toContain(" style=");
      expect(html).toContain("গ্রাহক");
    }
  });
});
