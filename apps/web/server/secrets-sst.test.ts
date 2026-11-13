import type { OrdersDeps } from "@tc/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assembleOrdersDeps } from "./orders-deps.ts";
import { assembleRuntime } from "./runtime.ts";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

// WPU-Z15 (B4): the Next.js server of SST 4.17.2 gets its links from the wrapper that decrypts the
// encrypted link file into globalThis.SST_KEY_FILE_DATA before the app loads; the SST_RESOURCE_<Name>
// variables exist for `next build` only, never at run time. The SST SDK loads its links once per
// process, so this file holds this one scenario. Planted values, never real ones (R3).
const secret = (value: string) => ({ type: "sst.sst.Secret", value });
const LINKS = {
  App: { name: "ticoncloud", stage: "staging" },
  EpsMerchantId: secret("planted-merchant-1111"),
  EpsStoreId: secret("planted-store-2222"),
  EpsUsername: secret("planted-user-3333"),
  EpsPassword: secret("planted-password-4444"),
  EpsHashKey: secret("planted-hashkey-5555"),
  EpsLimitKey: secret("planted-limitkey-6666"),
  AuthLimitKey: secret("planted-authkey-7777-0123456789abcdef"),
  OtpHashKey: secret("planted-otpkey-8888-0123456789abcdef"),
  SmsApiKey: secret("planted-smstoken-9999"),
  SmsSenderId: secret("PLANTEDSENDER0000"),
  OrderDraftSecret: secret("planted-draft-secret-0123456789abcdef"),
};
const holder = globalThis as Record<string, unknown>;
beforeAll(() => {
  holder["SST_KEY_FILE_DATA"] = LINKS;
});
afterAll(() => {
  delete holder["SST_KEY_FILE_DATA"];
});

const STAGING = {
  TC_STAGE: "staging",
  APP_ORIGIN: "https://cloud.example.com",
  NODE_ENV: "production",
  COGNITO_CUSTOMER_POOL_ID: "eu-west-1_Abc123XyZ",
  COGNITO_CUSTOMER_CLIENT_ID: "abcdefghij1234567890",
};

it("the runtime builds EPS, the auth keys and the OTP gateway from the links of the server", async () => {
  expect(Object.keys(process.env).filter((name) => name.startsWith("SST_RESOURCE_"))).toEqual([]);
  const { runtime, deps } = await assembleRuntime(STAGING);
  expect(runtime.eps).not.toBeNull();
  expect(deps?.limitKey).toBe("planted-limitkey-6666");
  expect(runtime.authLimitKey).toBe("planted-authkey-7777-0123456789abcdef");
  expect(runtime.otp?.sms.constructor.name).toBe("GatewaySmsProvider");
  expect(runtime.otp?.pepper).toBe("planted-otpkey-8888-0123456789abcdef");
});

it("the order functions get the draft secret from the links of the server", () => {
  const run = (async () => {
    throw new Error("no database in this test");
  }) as unknown as OrdersDeps["run"];
  const deps = assembleOrdersDeps(
    {
      stage: "staging",
      appOrigin: "https://cloud.example.com",
      epsMode: "sandbox",
      fakes: false,
      fake: { eps: false, idp: false, sms: false },
    },
    {},
    { run, clock: { now: () => new Date() } },
  );
  expect(deps).not.toBeNull();
  expect(Buffer.from(deps?.secrets[0] ?? new Uint8Array()).toString("utf8")).toBe(
    "planted-draft-secret-0123456789abcdef",
  );
});
