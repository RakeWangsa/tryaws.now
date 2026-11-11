// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { MoneyText } from "./MoneyText";

describe("MoneyText", () => {
  it("renders Bengali numerals under bn and Latin under en", () => {
    expect(renderKit(<MoneyText minor={123450n} />, { locale: "bn" }).container.textContent).toBe(
      "৳১,২৩৪.৫০",
    );
    expect(renderKit(<MoneyText minor={123450n} />, { locale: "en" }).container.textContent).toBe(
      "৳1,234.50",
    );
  });
  it("rounds up to whole taka", () => {
    const { container } = renderKit(<MoneyText minor={123450n} mode="wholeUp" />, { locale: "en" });
    expect(container.textContent).toBe("৳1,235");
  });
  it("lets numerals override and never prints BDT", () => {
    const { container } = renderKit(<MoneyText minor={123450n} numerals="latn" />, {
      locale: "bn",
    });
    expect(container.textContent).toBe("৳1,234.50");
    expect(container.textContent).not.toContain("BDT");
  });
  it("applies className, known classes only, and no inline style", () => {
    const { container } = renderKit(<MoneyText minor={5n} className="text-muted" />);
    expect(container.querySelector("span")?.classList.contains("text-muted")).toBe(true);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(<MoneyText minor={5n} className="text-muted" />)).not.toContain(" style=");
  });
  it("throws for a number", () => {
    expect(() => renderKit(<MoneyText minor={5 as unknown as bigint} />)).toThrow(TypeError);
  });
});
