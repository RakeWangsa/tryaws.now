// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AccountMenu } from "./parts/AccountMenu.tsx";

function menu() {
  return render(
    <AccountMenu
      label="Account"
      name="Rahim"
      detail="Signed in as Ops"
      items={[
        { href: "/settings/profile", label: "Profile" },
        { href: "/settings/security", label: "Security" },
      ]}
      footer={
        <form action="/sign-out" method="post">
          <button type="submit">Sign out</button>
        </form>
      }
    />,
  );
}

describe("AccountMenu", () => {
  it("trigger has aria-haspopup and the label", () => {
    menu();
    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opening shows the name, the detail, the items and the footer slot", async () => {
    const user = userEvent.setup();
    menu();
    await user.click(screen.getByRole("button", { name: "Account" }));
    const list = screen.getByRole("menu");
    expect(list.textContent).toContain("Rahim");
    expect(list.textContent).toContain("Signed in as Ops");
    const links = screen.getAllByRole("menuitem").filter((el) => el.tagName === "A");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/settings/profile",
      "/settings/security",
    ]);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("Escape closes", async () => {
    const user = userEvent.setup();
    menu();
    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
