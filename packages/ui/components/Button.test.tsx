// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ssr, renderKit, unknownClasses } from "../test/render";
import { Button } from "./Button";
import type { LinkComponent } from "./types";

const VARIANTS = [
  ["primary", "btn btn-default-yellow-fill"],
  ["secondary", "btn btn-default-pink-fill"],
  ["tertiary", "btn btn-default-pink"],
  ["destructive", "btn btn-danger tc-btn-danger"],
  ["default", "btn btn-default-fill"],
] as const;

const classesOf = (el: Element): string[] => [...el.classList].sort();
const expected = (list: string): string[] => list.split(" ").sort();

describe("Button", () => {
  it.each(VARIANTS)("variant %s has the classes %s", (variant, classes) => {
    const { container } = renderKit(<Button variant={variant}>Go</Button>);
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(classesOf(button)).toEqual(expected(classes));
    expect(unknownClasses(container)).toEqual([]);
  });

  it("the default variant is primary", () => {
    const { container } = renderKit(<Button>Go</Button>);
    expect(classesOf(container.querySelector("button") as Element)).toEqual(
      expected("btn btn-default-yellow-fill"),
    );
  });

  it("type is button by default and submit is kept", () => {
    const first = renderKit(<Button>Go</Button>);
    expect(first.container.querySelector("button")?.getAttribute("type")).toBe("button");
    first.unmount();
    const second = renderKit(<Button type="submit">Go</Button>);
    expect(second.container.querySelector("button")?.getAttribute("type")).toBe("submit");
  });

  it("size sm adds btn-sm and md does not", () => {
    const sm = renderKit(<Button size="sm">Go</Button>);
    expect(sm.container.querySelector("button")?.classList.contains("btn-sm")).toBe(true);
    expect(unknownClasses(sm.container)).toEqual([]);
    sm.unmount();
    const md = renderKit(<Button size="md">Go</Button>);
    expect(md.container.querySelector("button")?.classList.contains("btn-sm")).toBe(false);
  });

  it("className is appended", () => {
    const { container } = renderKit(<Button className="mt-3">Go</Button>);
    const button = container.querySelector("button") as Element;
    expect(button.classList.contains("mt-3")).toBe(true);
    expect(button.classList.contains("btn")).toBe(true);
  });

  it("passes other button props through", () => {
    const { container } = renderKit(
      <Button name="x" value="y" form="f1">
        Go
      </Button>,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("name")).toBe("x");
    expect(button.getAttribute("value")).toBe("y");
    expect(button.getAttribute("form")).toBe("f1");
  });

  describe.each([
    ["bn", "অপেক্ষা করুন"],
    ["en", "Please wait"],
  ] as const)("pending in %s", (locale, text) => {
    it("disables the button, marks it busy, shows the spinner and the hidden text", () => {
      const { container } = renderKit(<Button pending>Save</Button>, { locale });
      const button = container.querySelector("button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBe("true");
      const spinner = button.querySelector("span.spinner-border.spinner-border-sm.me-2");
      expect(spinner).not.toBeNull();
      expect(spinner?.getAttribute("aria-hidden")).toBe("true");
      const hidden = button.querySelector("span.visually-hidden");
      expect(hidden?.textContent).toBe(text);
      expect(button.textContent).toContain("Save");
      expect(unknownClasses(container)).toEqual([]);
    });
  });

  it("a button that is not pending has no aria-busy, no spinner and no hidden text", () => {
    const { container } = renderKit(<Button>Save</Button>);
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.querySelector(".spinner-border")).toBeNull();
    expect(button.querySelector(".visually-hidden")).toBeNull();
  });

  it("clicking a disabled pending button calls no handler", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { container } = renderKit(
      <Button pending onClick={onClick}>
        Save
      </Button>,
    );
    await user.click(container.querySelector("button") as HTMLButtonElement);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("clicking an enabled button calls the handler once", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { container } = renderKit(<Button onClick={onClick}>Save</Button>);
    await user.click(container.querySelector("button") as HTMLButtonElement);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a disabled button stays disabled without pending and has no aria-busy", () => {
    const { container } = renderKit(<Button disabled>Save</Button>);
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("icon renders an aria-hidden <i> before the children", () => {
    const { container } = renderKit(<Button icon="fas fa-plus">Add</Button>);
    const icon = container.querySelector("button > i") as HTMLElement;
    expect(icon.getAttribute("class")).toBe("fas fa-plus me-2");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("button")?.firstElementChild).toBe(icon);
    expect(unknownClasses(container)).toEqual([]);
  });

  describe("href", () => {
    it("renders an anchor with the classes and the href", () => {
      const { container } = renderKit(
        <Button href="/plans" variant="secondary" size="sm">
          Plans
        </Button>,
      );
      expect(container.querySelector("button")).toBeNull();
      const anchor = container.querySelector("a") as HTMLAnchorElement;
      expect(anchor.getAttribute("href")).toBe("/plans");
      expect(classesOf(anchor)).toEqual(expected("btn btn-default-pink-fill btn-sm"));
      expect(anchor.hasAttribute("aria-disabled")).toBe(false);
      expect(anchor.hasAttribute("tabindex")).toBe(false);
      expect(unknownClasses(container)).toEqual([]);
    });

    it("pending makes the anchor inert", () => {
      const { container } = renderKit(
        <Button href="/plans" pending>
          Plans
        </Button>,
      );
      const anchor = container.querySelector("a") as HTMLAnchorElement;
      expect(anchor.getAttribute("aria-disabled")).toBe("true");
      expect(anchor.getAttribute("tabindex")).toBe("-1");
      expect(anchor.classList.contains("disabled")).toBe(true);
      expect(anchor.querySelector(".spinner-border")).not.toBeNull();
      expect(anchor.querySelector(".visually-hidden")?.textContent).toBe("অপেক্ষা করুন");
    });

    it("disabled makes the anchor inert", () => {
      const { container } = renderKit(
        <Button href="/plans" disabled>
          Plans
        </Button>,
      );
      const anchor = container.querySelector("a") as HTMLAnchorElement;
      expect(anchor.getAttribute("aria-disabled")).toBe("true");
      expect(anchor.getAttribute("tabindex")).toBe("-1");
      expect(anchor.classList.contains("disabled")).toBe(true);
    });

    it("as is rendered with href and className", () => {
      const Custom: LinkComponent = ({ href, className, children, ...rest }) => (
        <a data-custom="yes" href={href} className={className} {...rest}>
          {children}
        </a>
      );
      const { container } = renderKit(
        <Button as={Custom} href="/x" variant="tertiary">
          X
        </Button>,
      );
      const anchor = container.querySelector("a") as HTMLAnchorElement;
      expect(anchor.getAttribute("data-custom")).toBe("yes");
      expect(anchor.getAttribute("href")).toBe("/x");
      expect(classesOf(anchor)).toEqual(expected("btn btn-default-pink"));
    });
  });

  describe("every locale and the server render", () => {
    it.each(["bn", "en"] as const)("renders in %s", (locale) => {
      const { container } = renderKit(<Button pending>Save</Button>, { locale });
      expect(container.querySelector("button")).not.toBeNull();
    });

    it("has no style attribute in the server markup", () => {
      for (const element of [
        <Button key="a">Go</Button>,
        <Button key="b" pending icon="fas fa-plus">
          Go
        </Button>,
        <Button key="c" href="/x" pending>
          Go
        </Button>,
      ]) {
        expect(ssr(element)).not.toContain(" style=");
        expect(ssr(element, { locale: "en" })).not.toContain(" style=");
      }
    });
  });
});
