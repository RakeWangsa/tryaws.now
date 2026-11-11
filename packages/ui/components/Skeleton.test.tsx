// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { Skeleton } from "./Skeleton";

function quietly(fn: () => void): void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("Skeleton", () => {
  it("renders three lines by default, each in a p.mb-2", () => {
    const { container } = renderKit(<Skeleton />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("placeholder-glow")).toBe(true);
    const lines = root.querySelectorAll("p.mb-2 > span.placeholder");
    expect(lines.length).toBe(3);
  });

  it("cycles the widths 12, 10, 8", () => {
    const { container } = renderKit(<Skeleton lines={5} />);
    const widths = [...container.querySelectorAll("span.placeholder")].map((el) =>
      [...el.classList].find((name) => name.startsWith("col-")),
    );
    expect(widths).toEqual(["col-12", "col-10", "col-8", "col-12", "col-10"]);
  });

  it("accepts 1 and 12 lines", () => {
    for (const lines of [1, 12]) {
      const { container, unmount } = renderKit(<Skeleton lines={lines} />);
      expect(container.querySelectorAll("span.placeholder").length).toBe(lines);
      unmount();
    }
  });

  it("throws RangeError for a count outside 1 to 12 or not whole", () => {
    quietly(() => {
      for (const lines of [0, 13, 20, -1, 2.5, Number.NaN]) {
        expect(() => renderKit(<Skeleton lines={lines} />), String(lines)).toThrow(RangeError);
      }
    });
  });

  it("is marked busy", () => {
    const { container } = renderKit(<Skeleton />);
    expect((container.firstElementChild as HTMLElement).getAttribute("aria-busy")).toBe("true");
  });

  it("says Loading in both locales for assistive technology", () => {
    const en = renderKit(<Skeleton />, { locale: "en" });
    expect(en.container.querySelector("span.visually-hidden")?.textContent).toBe("Loading");
    en.unmount();
    const bn = renderKit(<Skeleton />, { locale: "bn" });
    expect(bn.container.querySelector("span.visually-hidden")?.textContent).toBe("লোড হচ্ছে");
  });

  it("adds the class of the caller", () => {
    const { container } = renderKit(<Skeleton className="mb-4" />);
    expect((container.firstElementChild as HTMLElement).className).toBe("placeholder-glow mb-4");
  });

  it("uses only known classes and no inline style", () => {
    const { container } = renderKit(<Skeleton lines={4} />);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(<Skeleton lines={4} />)).not.toContain(" style=");
  });
});
