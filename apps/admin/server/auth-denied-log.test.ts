import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

// Staging 2026-11-14: a refused admin session left no trace. The line holds the reason code only (R14).
it("logs one structured line with the reason code and nothing else", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { logAuthDenied } = await import("./runtime.ts");
  logAuthDenied("unknown_subject");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
    level: "warn",
    event: "admin.auth_denied",
    app: "admin",
    reason: "unknown_subject",
  });
});
