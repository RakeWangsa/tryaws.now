// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopy } from "./use-copy";

describe("useCopy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("copied returns to idle after 2000 ms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { result } = renderHook(() => useCopy());
    expect(result.current.status).toBe("idle");
    await act(async () => {
      await result.current.copy("abc");
    });
    expect(writeText).toHaveBeenCalledWith("abc");
    expect(result.current.status).toBe("copied");
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current.status).toBe("copied");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.status).toBe("idle");
  });

  it("a rejection is failed", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
    });
    const { result } = renderHook(() => useCopy());
    await act(async () => {
      await result.current.copy("abc");
    });
    expect(result.current.status).toBe("failed");
  });

  it("no clipboard is failed", async () => {
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useCopy());
    await act(async () => {
      await result.current.copy("abc");
    });
    expect(result.current.status).toBe("failed");
  });

  it("unmount clears the timer", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { result, unmount } = renderHook(() => useCopy());
    await act(async () => {
      await result.current.copy("abc");
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
