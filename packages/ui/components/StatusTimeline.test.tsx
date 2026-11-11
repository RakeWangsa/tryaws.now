// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { StatusTimeline } from "./StatusTimeline";

const steps = [
  { id: "a", label: "Order placed", state: "done" as const },
  { id: "b", label: "Creating server", state: "current" as const },
  { id: "c", label: "Ready", state: "pending" as const },
  { id: "d", label: "Backup", state: "failed" as const },
];

describe("StatusTimeline", () => {
  it("is a card with an ordered list named by label", () => {
    const { container } = renderKit(<StatusTimeline label="Order progress" steps={steps} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("sec-main")).toBe(true);
    const list = root.querySelector("ol.list-unstyled.tc-timeline") as HTMLElement;
    expect(list.getAttribute("aria-label")).toBe("Order progress");
    expect(list.querySelectorAll(":scope > li.tc-timeline-step").length).toBe(4);
  });

  it("maps each state to a class, an icon and a hidden word (en)", () => {
    const { container } = renderKit(<StatusTimeline label="L" steps={steps} />, { locale: "en" });
    const items = [...container.querySelectorAll("li")];
    const table = [
      ["tc-timeline-done", "fas fa-check-circle", "Done"],
      ["tc-timeline-current", "fas fa-dot-circle", "In progress"],
      ["tc-timeline-pending", "far fa-circle", "Waiting"],
      ["tc-timeline-failed", "fas fa-times-circle", "Failed"],
    ] as const;
    items.forEach((li, index) => {
      const [cls, icon, word] = table[index] as readonly [string, string, string];
      expect(li.classList.contains(cls), cls).toBe(true);
      const i = li.querySelector("i") as HTMLElement;
      for (const name of icon.split(" ")) expect(i.classList.contains(name)).toBe(true);
      expect(i.getAttribute("aria-hidden")).toBe("true");
      expect(li.querySelector("span.visually-hidden")?.textContent).toBe(word);
    });
  });

  it("says the words in bn", () => {
    const { container } = renderKit(<StatusTimeline label="L" steps={steps} />, { locale: "bn" });
    const words = [...container.querySelectorAll("span.visually-hidden")].map((s) => s.textContent);
    expect(words).toEqual(["সম্পন্ন", "চলছে", "বাকি", "ব্যর্থ"]);
  });

  it("marks only the current step with aria-current=step", () => {
    const { container } = renderKit(<StatusTimeline label="L" steps={steps} />);
    const marked = container.querySelectorAll("[aria-current]");
    expect(marked.length).toBe(1);
    expect(marked[0]?.getAttribute("aria-current")).toBe("step");
    expect(marked[0]?.textContent).toContain("Creating server");
  });

  it("renders the label text of each step", () => {
    const { container } = renderKit(<StatusTimeline label="L" steps={steps} />);
    const text = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(text[0]).toContain("Order placed");
    expect(text[3]).toContain("Backup");
  });

  it("throws RangeError with two current steps", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        renderKit(
          <StatusTimeline
            label="L"
            steps={[
              { id: "a", label: "A", state: "current" },
              { id: "b", label: "B", state: "current" },
            ]}
          />,
        ),
      ).toThrow(RangeError);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders at as a <time> in Dhaka time", () => {
    const { container } = renderKit(
      <StatusTimeline
        label="L"
        steps={[{ id: "a", label: "A", state: "done", at: "2026-11-11T18:30:00Z" }]}
      />,
      { locale: "en" },
    );
    const time = container.querySelector("li time") as HTMLElement;
    expect(time.getAttribute("datetime")).toBe("2026-11-11T18:30:00.000Z");
    // 18:30 UTC is 00:30 on 12 November in Dhaka (UTC+6).
    expect(time.textContent).toContain("12");
    expect(time.textContent).toMatch(/12:30/);
  });

  it("has no <time> without at", () => {
    const { container } = renderKit(<StatusTimeline label="L" steps={steps} />);
    expect(container.querySelector("time")).toBeNull();
  });

  it("uses only known classes and no inline style", () => {
    const { container } = renderKit(<StatusTimeline label="L" steps={steps} />);
    expect(unknownClasses(container)).toEqual([]);
    expect(ssr(<StatusTimeline label="L" steps={steps} />)).not.toContain(" style=");
  });
});
