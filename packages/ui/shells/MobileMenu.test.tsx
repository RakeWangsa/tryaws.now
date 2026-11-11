// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileMenu } from "./parts/MobileMenu.tsx";

function setup() {
  const out = render(
    <MobileMenu label="Menu">
      <a href="/pricing">Pricing</a>
    </MobileMenu>,
  );
  const wrapper = out.container.querySelector("div.menu-wrap.mobile") as HTMLElement;
  const button = out.container.querySelector("button.menu-toggle#nav-toggle") as HTMLButtonElement;
  return { ...out, wrapper, button };
}

describe("MobileMenu", () => {
  it("starts closed: no active class, aria-expanded=false", () => {
    const { wrapper, button, container } = setup();
    expect(wrapper.classList.contains("active")).toBe(false);
    expect(button.classList.contains("active")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Menu");
    expect(button.querySelectorAll("span.icon")).toHaveLength(3);
    const menu = container.querySelector("div.main-menu.bg-seccolorstyle") as HTMLElement;
    expect(button.getAttribute("aria-controls")).toBe(menu.id);
  });

  it("click opens: active on wrapper and button, aria-expanded=true", () => {
    const { wrapper, button } = setup();
    fireEvent.click(button);
    expect(wrapper.classList.contains("active")).toBe(true);
    expect(button.classList.contains("active")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("Escape closes and focuses the button", () => {
    const { wrapper, button, getByText } = setup();
    fireEvent.click(button);
    const link = getByText("Pricing");
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(wrapper.classList.contains("active")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("second click closes", () => {
    const { wrapper, button } = setup();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(wrapper.classList.contains("active")).toBe(false);
    expect(button.classList.contains("active")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
