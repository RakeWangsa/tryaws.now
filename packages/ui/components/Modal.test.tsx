// @vitest-environment jsdom
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderKit, unknownClasses } from "../test/render";
import { Modal } from "./Modal";

const CLOSE = { bn: "বন্ধ করুন", en: "Close" } as const;

describe.each(["bn", "en"] as const)("Modal (%s)", (locale) => {
  it("is closed until the trigger is clicked, then names and describes the dialog", async () => {
    const user = userEvent.setup();
    renderKit(
      <Modal
        trigger={<button type="button">Open</button>}
        title="Remove item"
        description="Are you sure?"
        footer={<button type="button">Footer action</button>}
      >
        <p>Body text</p>
      </Modal>,
      { locale },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Remove item" });
    expect(dialog.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByText("Are you sure?").tagName).toBe("P");
    expect(document.querySelector("h5.modal-title")?.textContent).toBe("Remove item");
    expect(dialog.classList.contains("modal-dialog")).toBe(true);
    expect(dialog.querySelector(".modal-content > .modal-header")).not.toBeNull();
    expect(dialog.querySelector(".modal-content > .modal-body")?.textContent).toContain(
      "Body text",
    );
    expect(
      within(dialog.querySelector(".modal-footer") as HTMLElement).getByText("Footer action"),
    ).toBeTruthy();
    const close = dialog.querySelector("button.btn-close");
    expect(close?.getAttribute("aria-label")).toBe(CLOSE[locale]);
    expect(document.querySelector(".modal.fade.show.tc-modal-open")).not.toBeNull();
    expect(document.querySelector(".modal-backdrop.fade.show")).not.toBeNull();
    expect(unknownClasses(document.body)).toEqual([]);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderKit(
      <Modal trigger={<button type="button">Open</button>} title="T">
        <p>x</p>
      </Modal>,
      { locale },
    );
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("calls onOpenChange(false) on Escape, on the close button and on the dimmed area", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderKit(
      <Modal open onOpenChange={onOpenChange} title="T">
        <p>x</p>
      </Modal>,
      { locale },
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("dialog")).toBeTruthy(); // controlled: the parent decides
    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: CLOSE[locale] }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await user.click(document.querySelector(".modal-backdrop") as HTMLElement);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders no description paragraph when none is given", () => {
    renderKit(
      <Modal open title="T">
        <p>x</p>
      </Modal>,
      { locale },
    );
    expect(document.querySelector(".modal-body > p.mb-0")).toBeNull();
  });
});
