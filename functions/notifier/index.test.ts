import { afterEach, expect, it, vi } from "vitest";
import { handler, loadSesTransport } from "./index";
import { NOTIFIER_CONFIG_ERROR } from "./config";

afterEach(() => vi.unstubAllEnvs());

it("exports the handler that the stack wires", () => {
  expect(typeof handler).toBe("function");
});

it("has no SES transport yet: that is a hand-over, and the handler fails closed", () => {
  expect(loadSesTransport()).toBeNull();
});

it("fails closed with the fixed message when the configuration is missing", async () => {
  vi.stubEnv("PANEL_ORIGIN", "");
  await expect(handler({})).rejects.toThrow(NOTIFIER_CONFIG_ERROR);
});

it("fails closed with the fixed message when no SES transport is wired, before a database call", async () => {
  vi.stubEnv("PANEL_ORIGIN", "https://my.ticoncloud.test");
  vi.stubEnv("SES_FROM", "no-reply@ticoncloud.test");
  await expect(handler({})).rejects.toThrow("notifier: email is not configured");
});
