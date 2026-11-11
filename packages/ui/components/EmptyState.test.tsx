// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title, description and action", () => {
    const { container } = renderKit(
      <EmptyState
        title="No servers yet"
        description="Create your first server."
        action={<Button href="/new">Create a server</Button>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe("tc-empty text-center");
    const heading = root.querySelector("h2") as HTMLElement;
    expect(heading.className).toBe("h4 mergecolor");
    expect(heading.textContent).toBe("No servers yet");
    const description = root.querySelector("p.seccolor") as HTMLElement;
    expect(description.textContent).toBe("Create your first server.");
    expect(root.querySelector("a.btn")?.textContent).toBe("Create a server");
  });

  it("draws the default illustration as an inline svg, never an img", () => {
    const { container } = renderKit(<EmptyState title="Empty" />);
    const svg = container.querySelector("svg.tc-illustration") as SVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("viewBox")).toBe("0 0 120 90");
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses the illustration of the caller when given", () => {
    const { container } = renderKit(
      <EmptyState title="Empty" illustration={<i className="fas fa-box" data-mine="1" />} />,
    );
    expect(container.querySelector("[data-mine]")).not.toBeNull();
    expect(container.querySelector("svg.tc-illustration")).toBeNull();
  });

  it("wraps the full page variant like 404.html and uses h1", () => {
    const { container } = renderKit(<EmptyState title="Not found" fullPage />);
    const section = container.firstElementChild as HTMLElement;
    expect(section.tagName).toBe("SECTION");
    expect(section.classList.contains("sec-normal")).toBe(true);
    expect(section.classList.contains("notfound")).toBe(true);
    expect(section.querySelector("h1")?.textContent).toBe("Not found");
    expect(section.querySelector("h2")).toBeNull();
    expect(section.querySelector(".tc-empty")).not.toBeNull();
  });

  it("uses h2 outside the full page variant", () => {
    const { container } = renderKit(<EmptyState title="Empty" />);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).not.toBeNull();
  });

  it("renders no empty p without a description", () => {
    const { container } = renderKit(<EmptyState title="Empty" />);
    expect(container.querySelector("p")).toBeNull();
  });

  it("uses only known classes and no inline style, in both locales", () => {
    for (const locale of ["bn", "en"] as const) {
      const { container, unmount } = renderKit(
        <EmptyState title="T" description="D" action={<Button>Go</Button>} />,
        { locale },
      );
      expect(unknownClasses(container)).toEqual([]);
      unmount();
    }
    const full = <EmptyState title="T" fullPage />;
    const { container } = renderKit(full);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(full)).not.toContain(" style=");
  });
});
