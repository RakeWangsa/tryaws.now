// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderKit, unknownClasses } from "../test/render";
import { ConfirmDestroy, type ConfirmDestroyProps } from "./ConfirmDestroy";

const CONFIRM = { bn: "মুছে ফেলুন", en: "Delete" } as const;
const CANCEL = { bn: "বাতিল", en: "Cancel" } as const;
const LABEL = { bn: "নিশ্চিত করতে my-server লিখুন", en: "Type my-server to confirm" } as const;

const confirmButton = (locale: "bn" | "en"): HTMLButtonElement =>
  screen.getByRole("button", { name: new RegExp(CONFIRM[locale]) });

describe.each(["bn", "en"] as const)("ConfirmDestroy (%s)", (locale) => {
  const setup = (over: Partial<ConfirmDestroyProps> = {}) => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const view = renderKit(
      <ConfirmDestroy
        open
        onOpenChange={onOpenChange}
        resourceName="my-server"
        title="Delete server"
        description="This cannot be undone."
        onConfirm={onConfirm}
        {...over}
      />,
      { locale },
    );
    return { onConfirm, onOpenChange, view };
  };

  it("keeps confirm disabled until the exact name is typed", async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByLabelText(LABEL[locale]) as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(confirmButton(locale).disabled).toBe(true);
    expect(confirmButton(locale).classList.contains("btn-danger")).toBe(true);
    await user.type(input, "my-serv");
    expect(confirmButton(locale).disabled).toBe(true);
    await user.type(input, "er ");
    expect(confirmButton(locale).disabled).toBe(true); // trailing space
    await user.clear(input);
    await user.type(input, "MY-SERVER");
    expect(confirmButton(locale).disabled).toBe(true); // case counts
    await user.clear(input);
    await user.type(input, "my-server");
    expect(confirmButton(locale).disabled).toBe(false);
    expect(unknownClasses(document.body)).toEqual([]);
  });

  it("runs onConfirm once while its promise is pending", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    setup({ onConfirm });
    await user.type(screen.getByLabelText(LABEL[locale]), "my-server");
    await user.click(confirmButton(locale));
    await user.click(confirmButton(locale));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it("disables both buttons while pending", () => {
    setup({ pending: true });
    expect(confirmButton(locale).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: CANCEL[locale] }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.querySelector(".spinner-border")).not.toBeNull();
  });

  it("Cancel calls onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: CANCEL[locale] }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows an empty input when reopened", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <ConfirmDestroy
            open={open}
            onOpenChange={setOpen}
            resourceName="my-server"
            title="t"
            description="d"
            onConfirm={() => {}}
          />
        </>
      );
    }
    renderKit(<Harness />, { locale });
    await user.type(screen.getByLabelText(LABEL[locale]), "my-ser");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "reopen" }));
    expect((screen.getByLabelText(LABEL[locale]) as HTMLInputElement).value).toBe("");
  });

  it("throws RangeError for an empty resource name", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => setup({ resourceName: "" })).toThrow(RangeError);
    spy.mockRestore();
  });
});
