// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { PriceBreakdown } from "./PriceBreakdown";

const steps = [
  { code: "margin", label: "Service charge", amountMinor: 20000n },
  { code: "vat", label: "VAT", amountMinor: 15000n },
];

function rowsOf(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.children].map((cell) => cell.textContent ?? ""),
  );
}

function quietly(fn: () => void): void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("PriceBreakdown", () => {
  it("lists base, steps in order and total (en)", () => {
    const { container } = renderKit(
      <PriceBreakdown baseMinor={88450n} steps={steps} totalMinor={123450n} />,
      { locale: "en" },
    );
    expect(rowsOf(container)).toEqual([
      ["AWS service price", "৳884.50"],
      ["Service charge", "৳200.00"],
      ["VAT", "৳150.00"],
      ["Total", "৳1,234.50"],
    ]);
  });

  it("labels the base and total lines in bn", () => {
    const { container } = renderKit(
      <PriceBreakdown baseMinor={88450n} steps={steps} totalMinor={123450n} />,
      { locale: "bn" },
    );
    expect(rowsOf(container)[0]?.[0]).toBe("AWS সার্ভিস মূল্য");
    expect(rowsOf(container)[3]?.[0]).toBe("মোট");
  });

  it("uses the table markup of the mockup", () => {
    const { container } = renderKit(
      <PriceBreakdown baseMinor={88450n} steps={steps} totalMinor={123450n} />,
    );
    expect(
      container.querySelector("div.table-responsive-sm > table.table.compare.min > tbody"),
    ).not.toBeNull();
    const headers = container.querySelectorAll("tbody tr > th");
    expect(headers.length).toBe(4);
    for (const th of headers) expect(th.getAttribute("scope")).toBe("row");
  });

  it("keeps a zero step", () => {
    const { container } = renderKit(
      <PriceBreakdown
        baseMinor={100n}
        steps={[{ code: "vat", label: "VAT", amountMinor: 0n }]}
        totalMinor={100n}
      />,
      { locale: "en" },
    );
    expect(rowsOf(container)[1]).toEqual(["VAT", "৳0.00"]);
  });

  it("works with no steps", () => {
    const { container } = renderKit(
      <PriceBreakdown baseMinor={100n} steps={[]} totalMinor={100n} />,
    );
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
  });

  it("makes the total row bold", () => {
    const { container } = renderKit(
      <PriceBreakdown baseMinor={88450n} steps={steps} totalMinor={123450n} />,
    );
    const last = container.querySelector("tbody tr:last-child") as HTMLElement;
    expect(last.querySelectorAll("b").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("tbody b").length).toBe(last.querySelectorAll("b").length);
  });

  it("throws RangeError when the parts do not add up (R16)", () => {
    quietly(() => {
      expect(() =>
        renderKit(<PriceBreakdown baseMinor={88450n} steps={steps} totalMinor={123451n} />),
      ).toThrow(RangeError);
    });
  });

  it("throws TypeError for a number (R4)", () => {
    quietly(() => {
      const bad = 100 as unknown as bigint;
      expect(() =>
        renderKit(<PriceBreakdown baseMinor={bad} steps={[]} totalMinor={100n} />),
      ).toThrow(TypeError);
      expect(() =>
        renderKit(
          <PriceBreakdown
            baseMinor={100n}
            steps={[{ code: "x", label: "X", amountMinor: 1 as unknown as bigint }]}
            totalMinor={101n}
          />,
        ),
      ).toThrow(TypeError);
      expect(() =>
        renderKit(<PriceBreakdown baseMinor={100n} steps={[]} totalMinor={bad} />),
      ).toThrow(TypeError);
    });
  });

  it("uses only known classes and no inline style", () => {
    const ui = <PriceBreakdown baseMinor={88450n} steps={steps} totalMinor={123450n} />;
    const { container } = renderKit(ui);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(ui)).not.toContain(" style=");
  });
});
