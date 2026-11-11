// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { Tabs } from "./Tabs";

const tabs = [
  { id: "one", title: "One", content: <input aria-label="field" /> },
  { id: "two", title: "Two", content: <p>Second</p> },
  { id: "three", title: "Three", content: <p>Third</p> },
];

// login.html uses btn-select-customer as a hook that no stylesheet of the theme defines.
const notHook = (name: string): boolean => name !== "btn-select-customer";
const tabEl = (name: string) => screen.getByRole("tab", { name, hidden: true });
const panels = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[role=tabpanel]"),
];

describe("Tabs", () => {
  it("selects the first tab by default and hides the other panels", () => {
    const { container } = renderKit(<Tabs label="Demo" tabs={tabs} />);
    expect(tabEl("One").getAttribute("aria-selected")).toBe("true");
    expect(tabEl("One").className).toContain("active");
    expect(tabEl("Two").getAttribute("aria-selected")).toBe("false");
    expect(tabEl("Two").className).not.toContain("active");
    const [p1, p2, p3] = panels(container);
    expect(p1?.className).toContain("active");
    expect(p1?.hasAttribute("hidden")).toBe(false);
    for (const p of [p2, p3]) {
      expect(p?.hasAttribute("hidden")).toBe(true);
      expect(p?.className).not.toMatch(/\bactive\b/);
    }
  });

  it("uses the markup of the mockup", () => {
    const { container } = renderKit(<Tabs label="Demo" tabs={tabs} className="mb-5" />);
    expect(
      container.querySelector("div.tabs.mb-5 > div.tabs-header.btn-select-customer"),
    ).not.toBeNull();
    const list = container.querySelector("ul.btn-group.d-block[role=tablist]");
    expect(list?.getAttribute("aria-label")).toBe("Demo");
    expect(list?.querySelectorAll("li.btn.btn-secondary.mb-2[role=tab]").length).toBe(3);
    expect(container.querySelectorAll("div.table.tabs-item[role=tabpanel]").length).toBe(3);
    expect(unknownClasses(container).filter(notHook)).toEqual([]);
  });

  it("clicking a tab swaps the selection and the panel", async () => {
    const user = userEvent.setup();
    const { container } = renderKit(<Tabs label="Demo" tabs={tabs} />);
    await user.click(tabEl("Two"));
    expect(tabEl("Two").getAttribute("aria-selected")).toBe("true");
    expect(tabEl("One").getAttribute("aria-selected")).toBe("false");
    expect(tabEl("Two").className).toContain("active");
    const [p1, p2] = panels(container);
    expect(p1?.hasAttribute("hidden")).toBe(true);
    expect(p2?.hasAttribute("hidden")).toBe(false);
    expect(p2?.className).toContain("active");
  });

  it("ArrowRight on the last tab selects the first and moves the focus", async () => {
    const user = userEvent.setup();
    renderKit(<Tabs label="Demo" tabs={tabs} defaultId="three" />);
    tabEl("Three").focus();
    await user.keyboard("{ArrowRight}");
    expect(tabEl("One").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabEl("One"));
  });

  it("ArrowLeft on the first tab selects the last", async () => {
    const user = userEvent.setup();
    renderKit(<Tabs label="Demo" tabs={tabs} />);
    tabEl("One").focus();
    await user.keyboard("{ArrowLeft}");
    expect(tabEl("Three").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabEl("Three"));
  });

  it("ArrowRight moves to the next tab", async () => {
    const user = userEvent.setup();
    renderKit(<Tabs label="Demo" tabs={tabs} />);
    tabEl("One").focus();
    await user.keyboard("{ArrowRight}");
    expect(tabEl("Two").getAttribute("aria-selected")).toBe("true");
  });

  it("Home and End go to the first and last tab", async () => {
    const user = userEvent.setup();
    renderKit(<Tabs label="Demo" tabs={tabs} defaultId="two" />);
    tabEl("Two").focus();
    await user.keyboard("{End}");
    expect(tabEl("Three").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabEl("Three"));
    await user.keyboard("{Home}");
    expect(tabEl("One").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabEl("One"));
  });

  it("only the selected tab has tabindex 0", async () => {
    const user = userEvent.setup();
    renderKit(<Tabs label="Demo" tabs={tabs} />);
    expect(tabEl("One").getAttribute("tabindex")).toBe("0");
    expect(tabEl("Two").getAttribute("tabindex")).toBe("-1");
    expect(tabEl("Three").getAttribute("tabindex")).toBe("-1");
    await user.click(tabEl("Three"));
    expect(tabEl("Three").getAttribute("tabindex")).toBe("0");
    expect(tabEl("One").getAttribute("tabindex")).toBe("-1");
  });

  it("links tabs and panels both ways", () => {
    const { container } = renderKit(<Tabs label="Demo" tabs={tabs} />);
    const ps = panels(container);
    ["One", "Two", "Three"].forEach((name, i) => {
      const t = tabEl(name);
      const p = ps[i] as HTMLElement;
      expect(t.getAttribute("aria-controls")).toBe(p.id);
      expect(p.getAttribute("aria-labelledby")).toBe(t.id);
      expect(p.id).not.toBe("");
    });
  });

  it("two instances do not share ids", () => {
    const { container } = renderKit(
      <>
        <Tabs label="A" tabs={tabs} />
        <Tabs label="B" tabs={tabs} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaultId selects that tab", () => {
    const { container } = renderKit(<Tabs label="Demo" tabs={tabs} defaultId="two" />);
    expect(tabEl("Two").getAttribute("aria-selected")).toBe("true");
    expect(panels(container)[1]?.hasAttribute("hidden")).toBe(false);
  });

  it("throws for no tabs and for an unknown defaultId", () => {
    expect(() => ssr(<Tabs label="Demo" tabs={[]} />)).toThrow(RangeError);
    expect(() => ssr(<Tabs label="Demo" tabs={tabs} defaultId="nope" />)).toThrow();
  });

  it("server output holds every panel and no inline style", () => {
    const html = ssr(<Tabs label="Demo" tabs={tabs} />);
    expect(html).toContain("Second");
    expect(html).toContain("Third");
    expect(html).not.toContain(" style=");
    expect(unknownClasses(html).filter(notHook)).toEqual([]);
  });

  it("keeps panels mounted: typed text survives a switch", async () => {
    const user = userEvent.setup();
    renderKit(<Tabs label="Demo" tabs={tabs} />);
    await user.type(screen.getByLabelText("field"), "hello");
    await user.click(tabEl("Two"));
    await user.click(tabEl("One"));
    expect((screen.getByLabelText("field") as HTMLInputElement).value).toBe("hello");
  });
});
