// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { SecretReveal } from "./SecretReveal";

const SECRET = "S3cr3t!pw";
const DOTS = "••••••••••••";

let writeText: ReturnType<typeof vi.fn>;

const btn = (name: string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
// The output element has an implicit status role, so the message line is found by its tag.
const statusLine = (): HTMLElement => document.querySelector("p[role=status]") as HTMLElement;
const tick = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SecretReveal", () => {
  it("hidden: the secret is nowhere", () => {
    const { container } = renderKit(<SecretReveal label="Password" secret={SECRET} />);
    expect(document.documentElement.outerHTML).not.toContain(SECRET);
    expect(container.textContent).toContain(DOTS);
    for (const el of [container, ...container.querySelectorAll("*")]) {
      for (const attr of el.getAttributeNames()) {
        expect(el.getAttribute(attr)).not.toContain(SECRET);
      }
    }
    expect(unknownClasses(container)).toEqual([]);
  });

  it("server-rendered markup does not contain the secret", () => {
    const html = ssr(<SecretReveal label="Password" secret={SECRET} />);
    expect(html).not.toContain(SECRET);
    expect(html).toContain(DOTS);
  });

  it("the label names the output", () => {
    const { container } = renderKit(<SecretReveal label="Password" secret={SECRET} />, {
      locale: "en",
    });
    const output = container.querySelector("output") as HTMLOutputElement;
    const id = output.getAttribute("aria-labelledby") as string;
    expect(container.querySelector(`[id="${id}"]`)?.textContent).toBe("Password");
  });

  it("Show reveals it in a code element and Hide hides it again", () => {
    const { container } = renderKit(<SecretReveal label="Password" secret={SECRET} />, {
      locale: "en",
    });
    fireEvent.click(btn("Show"));
    expect(container.querySelector("code.tc-secret-value")?.textContent).toBe(SECRET);
    expect(unknownClasses(container)).toEqual([]);
    fireEvent.click(btn("Hide"));
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).not.toContain(SECRET);
    expect(container.textContent).toContain(DOTS);
  });

  it("is still shown at 59,999 ms; at 60,000 ms it is gone", async () => {
    const onHidden = vi.fn();
    const { container } = renderKit(
      <SecretReveal label="Password" secret={SECRET} onHidden={onHidden} />,
      { locale: "en" },
    );
    fireEvent.click(btn("Show"));
    await tick(59_999);
    expect(container.textContent).toContain(SECRET);
    expect(onHidden).not.toHaveBeenCalled();
    await tick(1);
    expect(container.textContent).not.toContain(SECRET);
    expect(document.documentElement.outerHTML).not.toContain(SECRET);
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(btn("Show").disabled).toBe(true);
    expect(btn("Copy").disabled).toBe(true);
    expect(statusLine().textContent).toBe("Hidden again. It will not be shown again.");
    await tick(120_000);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("the expired message is in Bengali too", async () => {
    renderKit(<SecretReveal label="Password" secret={SECRET} hideAfterMs={1000} />);
    fireEvent.click(btn("দেখান"));
    await tick(1000);
    expect(statusLine().textContent).toBe("লুকানো হয়েছে। এটি আর দেখানো হবে না।");
  });

  it("Hide at 10 s then Show at 20 s: the window still ends at 60 s after the first Show", async () => {
    const onHidden = vi.fn();
    const { container } = renderKit(
      <SecretReveal label="Password" secret={SECRET} onHidden={onHidden} />,
      { locale: "en" },
    );
    fireEvent.click(btn("Show"));
    await tick(10_000);
    fireEvent.click(btn("Hide"));
    await tick(10_000);
    fireEvent.click(btn("Show"));
    await tick(39_999);
    expect(container.textContent).toContain(SECRET);
    await tick(1);
    expect(container.textContent).not.toContain(SECRET);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("a custom hideAfterMs works", async () => {
    const { container } = renderKit(
      <SecretReveal label="Password" secret={SECRET} hideAfterMs={5000} />,
      { locale: "en" },
    );
    fireEvent.click(btn("Show"));
    await tick(4999);
    expect(container.textContent).toContain(SECRET);
    await tick(1);
    expect(container.textContent).not.toContain(SECRET);
  });

  it("Copy writes the secret and says Copied (en) / কপি হয়েছে (bn)", async () => {
    const en = renderKit(<SecretReveal label="Password" secret={SECRET} />, { locale: "en" });
    await act(async () => {
      fireEvent.click(btn("Copy"));
    });
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(statusLine().textContent).toBe("Copied");
    expect(document.documentElement.outerHTML).not.toContain(SECRET);
    en.unmount();
    renderKit(<SecretReveal label="Password" secret={SECRET} />, { locale: "bn" });
    await act(async () => {
      fireEvent.click(btn("কপি করুন"));
    });
    expect(statusLine().textContent).toBe("কপি হয়েছে");
  });

  it("a rejected writeText shows the failure message", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderKit(<SecretReveal label="Password" secret={SECRET} />, { locale: "en" });
    await act(async () => {
      fireEvent.click(btn("Copy"));
    });
    expect(statusLine().textContent).toBe("Could not copy");
  });

  it("unmount clears the timers", () => {
    const view = renderKit(<SecretReveal label="Password" secret={SECRET} />, { locale: "en" });
    fireEvent.click(btn("Show"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never touches web storage or the console", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log");
    const info = vi.spyOn(console, "info");
    renderKit(<SecretReveal label="Password" secret={SECRET} hideAfterMs={1000} />, {
      locale: "en",
    });
    fireEvent.click(btn("Show"));
    await act(async () => {
      fireEvent.click(btn("Copy"));
    });
    await tick(1000);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
