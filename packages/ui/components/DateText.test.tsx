// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { DateText } from "./DateText";
import { formatDate } from "./format";

const iso = "2026-11-11T18:30:00.000Z";

describe("DateText", () => {
  it("renders a time element with the ISO datetime and the formatted text", () => {
    const { container } = renderKit(<DateText value={iso} variant="datetime" />, { locale: "en" });
    const el = container.querySelector("time");
    expect(el?.getAttribute("datetime")).toBe(iso);
    expect(el?.textContent).toBe(formatDate(iso, { locale: "en", variant: "datetime" }));
  });
  it("renders the same for a Date and its ISO string, in bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      const a = renderKit(<DateText value={new Date(iso)} />, { locale }).container.innerHTML;
      const b = renderKit(<DateText value={iso} />, { locale }).container.innerHTML;
      expect(a).toBe(b);
    }
  });
  it("uses known classes and no inline style", () => {
    const { container } = renderKit(<DateText value={iso} className="text-muted" />);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(<DateText value={iso} />)).not.toContain(" style=");
  });
});
