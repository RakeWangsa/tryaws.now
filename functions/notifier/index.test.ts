import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { handler, loadSesTransport, loadSmsProvider } from "./index";
import { NOTIFIER_CONFIG_ERROR } from "./config";

afterEach(() => vi.unstubAllEnvs());

// Obviously fake values (R3).
const SMS_ENV = {
  SST_RESOURCE_SmsApiKey: '{"type":"sst.sst.Secret","value":"fake-notifier-sms-token"}',
  SST_RESOURCE_SmsSenderId: '{"type":"sst.sst.Secret","value":"FAKESENDERID"}',
};

it("has an SMS provider only when both SMS secrets are readable (WPU-Z3)", () => {
  expect(loadSmsProvider({})).toBeNull();
  expect(loadSmsProvider({ SST_RESOURCE_SmsApiKey: SMS_ENV.SST_RESOURCE_SmsApiKey })).toBeNull();
  expect(
    loadSmsProvider({ SST_RESOURCE_SmsSenderId: SMS_ENV.SST_RESOURCE_SmsSenderId }),
  ).toBeNull();
  expect(loadSmsProvider({ ...SMS_ENV, SST_RESOURCE_SmsApiKey: '{"value":""}' })).toBeNull();
  expect(loadSmsProvider({ ...SMS_ENV, SST_RESOURCE_SmsSenderId: "{not json" })).toBeNull();
  const provider = loadSmsProvider(SMS_ENV);
  expect(provider?.constructor.name).toBe("GatewaySmsProvider");
  expect(typeof provider?.send).toBe("function");
});

it("the SMS provider shows neither the token nor the sender id, in JSON or in inspect", () => {
  const provider = loadSmsProvider(SMS_ENV);
  const shown = [JSON.stringify(provider), inspect(provider, { depth: 10, showHidden: true })].join(
    "\n",
  );
  expect(shown).not.toContain("fake-notifier-sms-token");
  expect(shown).not.toContain("FAKESENDERID");
});

it("exports the handler that the stack wires", () => {
  expect(typeof handler).toBe("function");
});

it("has no SES transport without an identity ARN, and the handler fails closed", () => {
  expect(loadSesTransport({})).toBeNull();
  expect(
    typeof loadSesTransport({
      SES_IDENTITY_ARN: "arn:aws:ses:ap-southeast-1:123456789012:identity/ticoncloud.test",
    })?.send,
  ).toBe("function");
});

it("fails closed with the fixed message when the configuration is missing", async () => {
  vi.stubEnv("PANEL_ORIGIN", "");
  await expect(handler({})).rejects.toThrow(NOTIFIER_CONFIG_ERROR);
});

it("fails closed with the fixed message when no SES transport is wired, before a database call", async () => {
  vi.stubEnv("PANEL_ORIGIN", "https://my.ticoncloud.test");
  vi.stubEnv("SES_FROM", "no-reply@ticoncloud.test");
  vi.stubEnv("SES_IDENTITY_ARN", "");
  await expect(handler({})).rejects.toThrow("notifier: email is not configured");
});
