// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { Accordion } from "./Accordion";

const items = [
  { id: "a", title: "Alpha", content: <p>Alpha body</p> },
  { id: "b", title: "Beta", content: <p>Beta body</p> },
];

const trigger = (name: string) => screen.getByRole("button", { name, hidden: true });
const regions = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".panel-collapse")];
const titles = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".panel-title")];

describe("Accordion", () => {
  it("is closed by default", () => {
    const { container } = renderKit(<Accordion items={items} />);
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("false");
    expect(trigger("Beta").getAttribute("aria-expanded")).toBe("false");
    for (const r of regions(container)) expect(r.hasAttribute("hidden")).toBe(true);
    for (const t of titles(container)) expect(t.className).not.toMatch(/\bactive\b/);
  });

  it("uses the markup of the mockup", () => {
    const { container } = renderKit(<Accordion items={items} className="mb-5" defaultOpenId="a" />);
    expect(
      container.querySelector(
        "div.accordion.faq.mb-5 > div.panel-wrap > div.panel-title.mergecolor.active > h3.tc-accordion-heading > button.tc-accordion-trigger[type=button]",
      ),
    ).not.toBeNull();
    expect(container.querySelector("button > span")?.textContent).toBe("Alpha");
    expect(container.querySelector("button > div.float-end > i.fa.fa-plus")).not.toBeNull();
    expect(container.querySelector("button > div.float-end > i.fa.fa-minus.c-pink")).not.toBeNull();
    for (const icon of container.querySelectorAll("i.fa")) {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
    expect(
      container.querySelector(
        "div.panel-collapse[role=region] > div.wrapper-collapse > div.info > p",
      )?.textContent,
    ).toBe("Alpha body");
    expect(unknownClasses(container)).toEqual([]);
  });

  it("opens on click and closes the other one", async () => {
    const user = userEvent.setup();
    const { container } = renderKit(<Accordion items={items} />);
    await user.click(trigger("Alpha"));
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("true");
    expect(titles(container)[0]?.className).toContain("active");
    expect(regions(container)[0]?.hasAttribute("hidden")).toBe(false);
    await user.click(trigger("Beta"));
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("false");
    expect(trigger("Beta").getAttribute("aria-expanded")).toBe("true");
    expect(titles(container)[0]?.className).not.toMatch(/\bactive\b/);
    expect(regions(container)[0]?.hasAttribute("hidden")).toBe(true);
  });

  it("clicking the open one closes it", async () => {
    const user = userEvent.setup();
    renderKit(<Accordion items={items} defaultOpenId="a" />);
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("true");
    await user.click(trigger("Alpha"));
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("false");
  });

  it("defaultOpenId opens one item", () => {
    renderKit(<Accordion items={items} defaultOpenId="b" />);
    expect(trigger("Beta").getAttribute("aria-expanded")).toBe("true");
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("false");
  });

  it("uses h3 by default and the given heading level", () => {
    const a = renderKit(<Accordion items={items} />);
    expect(a.container.querySelectorAll("h3").length).toBe(2);
    a.unmount();
    const b = renderKit(<Accordion items={items} headingLevel={2} />);
    expect(b.container.querySelectorAll("h2").length).toBe(2);
    b.unmount();
    const c = renderKit(<Accordion items={items} headingLevel={4} />);
    expect(c.container.querySelectorAll("h4").length).toBe(2);
  });

  it("Enter and Space toggle", async () => {
    const user = userEvent.setup();
    renderKit(<Accordion items={items} />);
    trigger("Alpha").focus();
    await user.keyboard("{Enter}");
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("true");
    await user.keyboard(" ");
    expect(trigger("Alpha").getAttribute("aria-expanded")).toBe("false");
  });

  it("labels each region by its button", () => {
    const { container } = renderKit(<Accordion items={items} />);
    regions(container).forEach((r, i) => {
      const b = trigger(i === 0 ? "Alpha" : "Beta");
      expect(b.getAttribute("aria-controls")).toBe(r.id);
      expect(r.getAttribute("aria-labelledby")).toBe(b.id);
      expect(r.id).not.toBe("");
    });
  });

  it("two instances do not share ids", () => {
    const { container } = renderKit(
      <>
        <Accordion items={items} />
        <Accordion items={items} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("throws for an unknown defaultOpenId", () => {
    expect(() => ssr(<Accordion items={items} defaultOpenId="nope" />)).toThrow();
  });

  it("server output has every body and no inline style", () => {
    const html = ssr(<Accordion items={items} />);
    expect(html).toContain("Beta body");
    expect(html).not.toContain(" style=");
    expect(unknownClasses(html)).toEqual([]);
  });
});
