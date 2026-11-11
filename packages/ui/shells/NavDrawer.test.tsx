// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NavDrawer } from "./parts/NavDrawer.tsx";

function drawer() {
  return render(
    <NavDrawer openLabel="Open navigation" closeLabel="Close" title="Panel menu">
      <nav aria-label="Panel menu">
        <a href="/servers">Servers</a>
      </nav>
    </NavDrawer>,
  );
}

describe("NavDrawer", () => {
  it("closed: no dialog in the DOM", () => {
    drawer();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Servers")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    expect(trigger.className).toContain("d-lg-none");
  });

  it("click on the trigger opens a dialog containing the nav, in the offcanvas classes", async () => {
    const user = userEvent.setup();
    drawer();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = screen.getByRole("dialog", { name: "Panel menu" });
    for (const name of ["offcanvas", "offcanvas-start", "offcanvas-box", "bg-colorstyle", "show"]) {
      expect(dialog.classList.contains(name), name).toBe(true);
    }
    expect(dialog.querySelector("a[href='/servers']")).not.toBeNull();
    expect(document.querySelector("div.offcanvas-backdrop.fade.show")).not.toBeNull();
  });

  it("Escape closes it", async () => {
    const user = userEvent.setup();
    drawer();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the close button closes it", async () => {
    const user = userEvent.setup();
    drawer();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("focus returns to the trigger", async () => {
    const user = userEvent.setup();
    drawer();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
  });
});
