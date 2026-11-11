// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderKit, unknownClasses } from "../test/render";
import { CopyField } from "./CopyField";

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CopyField", () => {
  it("ties the label to a read-only input with the value", () => {
    const { container } = renderKit(<CopyField label="IP address" value="203.0.113.7" />, {
      locale: "en",
    });
    const input = screen.getByLabelText("IP address") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("203.0.113.7");
    expect(unknownClasses(container)).toEqual([]);
  });

  it("copies the value and says so", async () => {
    renderKit(<CopyField label="IP address" value="203.0.113.7" />, { locale: "en" });
    expect(screen.getByRole("status").textContent).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith("203.0.113.7");
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("says কপি হয়েছে in Bengali", async () => {
    renderKit(<CopyField label="আইপি" value="203.0.113.7" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "কপি করুন" }));
    });
    expect(screen.getByRole("status").textContent).toBe("কপি হয়েছে");
  });

  it("no clipboard shows the failure message", async () => {
    vi.stubGlobal("navigator", {});
    renderKit(<CopyField label="IP address" value="203.0.113.7" />, { locale: "en" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(screen.getByRole("status").textContent).toBe("Could not copy");
  });

  it("the hint id is in aria-describedby", () => {
    renderKit(<CopyField label="IP address" value="203.0.113.7" id="ip" hint="Public address" />, {
      locale: "en",
    });
    const input = screen.getByLabelText("IP address");
    expect(input.getAttribute("id")).toBe("ip");
    expect(input.getAttribute("aria-describedby")).toBe("ip-hint");
    expect(document.getElementById("ip-hint")?.textContent).toBe("Public address");
  });
});
