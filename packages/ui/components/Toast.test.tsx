// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderKit, ssr, unknownClasses } from "../test/render";
import { ToastProvider, useToast, type ToastInput } from "./Toast";

const TONE = {
  bn: { success: "সফল", info: "তথ্য", warning: "সতর্কতা", danger: "সমস্যা" },
  en: { success: "Success", info: "Information", warning: "Warning", danger: "Problem" },
} as const;
const REGION = { bn: "বিজ্ঞপ্তি", en: "Notifications" } as const;
const CLOSE = { bn: "বন্ধ করুন", en: "Close" } as const;

let api: ReturnType<typeof useToast>;
function Probe() {
  api = useToast();
  return null;
}
const mount = (locale: "bn" | "en") =>
  renderKit(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
    { locale },
  );
const show = (t: ToastInput) => act(() => api.show(t));

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("server HTML holds no inline style and no viewport", () => {
    const html = ssr(
      <ToastProvider>
        <p>x</p>
      </ToastProvider>,
    );
    expect(html).not.toContain(" style=");
    expect(html).not.toContain("toast-container");
    expect(html).toContain("<p>x</p>");
  });

  it("useToast outside a provider throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderKit(<Probe />)).toThrow(Error);
    spy.mockRestore();
  });

  it("show needs a title or a description", () => {
    mount("en");
    expect(() => api.show({})).toThrow(RangeError);
  });
});

describe.each(["bn", "en"] as const)("Toast (%s)", (locale) => {
  it("mounts the viewport after the first effect", () => {
    mount(locale);
    const viewport = document.querySelector("ol.toast-container");
    expect(viewport).not.toBeNull();
    for (const c of [
      "position-fixed",
      "bottom-0",
      "end-0",
      "p-3",
      "list-unstyled",
      "tc-toast-viewport",
    ]) {
      expect(viewport?.classList.contains(c)).toBe(true);
    }
    expect(document.querySelector(`[aria-label="${REGION[locale]}"]`)).not.toBeNull();
  });

  it("shows a toast with title, description, tone word and icon", async () => {
    mount(locale);
    await show({ title: "Saved", description: "All good", tone: "success" });
    const toast = document.querySelector(".toast.show") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.querySelector(".toast-header strong")?.textContent).toBe(TONE[locale].success);
    const icon = toast.querySelector(".toast-header i");
    expect(icon?.getAttribute("class")).toContain("fas fa-check-circle");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(toast.querySelector(".toast-body strong")?.textContent).toBe("Saved");
    expect(toast.querySelector(".toast-body")?.textContent).toContain("All good");
    expect(toast.querySelector("button.btn-close")?.getAttribute("aria-label")).toBe(CLOSE[locale]);
    expect(unknownClasses(document.body)).toEqual([]);
  });

  it.each([
    ["info", "fas fa-info-circle"],
    ["warning", "fas fa-exclamation-triangle"],
    ["danger", "fas fa-times-circle"],
  ] as const)("tone %s uses its icon and word", async (tone, icon) => {
    mount(locale);
    await show({ title: "t", tone });
    expect(document.querySelector(".toast-header i")?.getAttribute("class")).toContain(icon);
    expect(document.querySelector(".toast-header strong")?.textContent).toBe(TONE[locale][tone]);
  });

  it("defaults to the info tone", async () => {
    mount(locale);
    await show({ description: "d" });
    expect(document.querySelector(".toast-header strong")?.textContent).toBe(TONE[locale].info);
  });

  it("disappears after durationMs", async () => {
    vi.useFakeTimers();
    mount(locale);
    await show({ title: "Bye", durationMs: 1000 });
    expect(screen.queryByText("Bye")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText("Bye")).toBeNull();
  });

  it("uses 5000 ms by default", async () => {
    vi.useFakeTimers();
    mount(locale);
    await show({ title: "Slow" });
    await act(async () => {
      vi.advanceTimersByTime(4900);
    });
    expect(screen.queryByText("Slow")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Slow")).toBeNull();
  });

  it("the close button removes the toast; two toasts stack", async () => {
    mount(locale);
    await show({ title: "One" });
    await show({ title: "Two" });
    expect(document.querySelectorAll(".toast").length).toBe(2);
    const close = document.querySelector(".toast button.btn-close") as HTMLElement;
    await act(async () => close.click());
    expect(document.querySelectorAll(".toast").length).toBe(1);
  });
});
