// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ssr, renderKit, unknownClasses } from "../test/render";
import { SubmitButton } from "./SubmitButton";

describe("SubmitButton", () => {
  it("is a submit button with the primary classes", () => {
    const { container } = renderKit(
      <form>
        <SubmitButton>Save</SubmitButton>
      </form>,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.classList.contains("btn-default-yellow-fill")).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(unknownClasses(container)).toEqual([]);
  });

  it("keeps the variant and size", () => {
    const { container } = renderKit(
      <form>
        <SubmitButton variant="destructive" size="sm">
          Delete
        </SubmitButton>
      </form>,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.classList.contains("btn-danger")).toBe(true);
    expect(button.classList.contains("btn-sm")).toBe(true);
  });

  it("the pending prop alone disables it", () => {
    const { container } = renderKit(
      <form>
        <SubmitButton pending>Save</SubmitButton>
      </form>,
      { locale: "en" },
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector(".visually-hidden")?.textContent).toBe("Please wait");
  });

  it("is disabled and busy while the form action runs", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const action = (): Promise<void> => {
      calls += 1;
      return new Promise<void>(() => {});
    };
    const { container } = renderKit(
      <form action={action}>
        <SubmitButton>Save</SubmitButton>
      </form>,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    await user.click(button);
    expect(calls).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await user.click(button);
    expect(calls).toBe(1);
  });

  it("outside a form it is not pending", () => {
    const { container } = renderKit(<SubmitButton>Save</SubmitButton>);
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("has no style attribute in the server markup, in both locales", () => {
    const element = <SubmitButton pending>Save</SubmitButton>;
    expect(ssr(element)).not.toContain(" style=");
    expect(ssr(element, { locale: "en" })).not.toContain(" style=");
  });
});
