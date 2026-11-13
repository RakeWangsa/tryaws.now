import { sealSstLinks, type SealedSstLinks } from "@tc/db/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadSmsProvider } from "./index";

// WPU-Z15 (B4): a function deployed by SST 4.17.2 gets its links only in the encrypted link file
// (SST_KEY_FILE, SST_KEY); no SST_RESOURCE_<Name> variable holds them at run time. The SST SDK loads
// its links once per process, so this file holds this one scenario. Fake values (R3).
let sealed: SealedSstLinks;
beforeAll(() => {
  sealed = sealSstLinks({
    App: { name: "ticoncloud", stage: "staging" },
    SmsApiKey: { type: "sst.sst.Secret", value: "fake-notifier-sms-token" },
    SmsSenderId: { type: "sst.sst.Secret", value: "FAKESENDERID" },
  });
  vi.stubEnv("SST_KEY", sealed.env.SST_KEY);
  vi.stubEnv("SST_KEY_FILE", sealed.env.SST_KEY_FILE);
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sealed.remove();
});

it("builds the SMS gateway from the two secrets of the encrypted link file", async () => {
  expect(Object.keys(process.env).filter((name) => name.startsWith("SST_RESOURCE_"))).toEqual([]);
  const provider = loadSmsProvider();
  expect(provider?.constructor.name).toBe("GatewaySmsProvider");
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const answer = {
      status: "SUCCESS",
      status_code: 200,
      error_message: "",
      smsinfo: [{ sms_status: "SUCCESS", status_message: "Success", reference_id: "gw-1" }],
    };
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  expect(await provider?.send("+8801712345678", "test text", "notification-1")).toEqual({
    ok: true,
    messageId: "gw-1",
  });
  expect(bodies[0]).toMatchObject({ api_token: "fake-notifier-sms-token", sid: "FAKESENDERID" });
});
