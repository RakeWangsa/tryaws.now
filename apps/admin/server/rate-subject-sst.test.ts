import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveRateKey } from "./rate-subject.ts";

// WPU-Z15 (B4): the Next.js server of SST 4.17.2 gets its links from the wrapper that decrypts the
// encrypted link file into globalThis.SST_KEY_FILE_DATA before the app loads; no SST_RESOURCE_<Name>
// variable exists at run time. The SST SDK loads its links once per process, so this file holds this
// one scenario. A fake key (R3).
const KEY = "fake-admin-ip-limit-key-0123456789abcdef";
const holder = globalThis as Record<string, unknown>;
beforeAll(() => {
  holder["SST_KEY_FILE_DATA"] = {
    App: { name: "ticoncloud", stage: "production" },
    AdminIpLimitKey: { type: "sst.sst.Secret", value: KEY },
  };
});
afterAll(() => {
  delete holder["SST_KEY_FILE_DATA"];
});

it("reads the HMAC key of the rate-limit subject from the links of the server", () => {
  expect(Object.keys(process.env).filter((name) => name.startsWith("SST_RESOURCE_"))).toEqual([]);
  expect(resolveRateKey({ TC_STAGE: "production" })).toBe(KEY);
  expect(resolveRateKey({ TC_STAGE: "staging" })).toBe(KEY);
});
