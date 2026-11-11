import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFakeSms, getFakeState, resetFakeState } from "./fakes/outbox.ts";
import { GET as emailOutbox } from "../app/dev/idp/outbox/route.ts";
import { GET as smsOutbox } from "../app/dev/sms/outbox/route.ts";

const FAKE_ENV = {
  TC_STAGE: "test",
  APP_ORIGIN: "http://localhost:3000",
  NODE_ENV: "test",
  TC_IDP: "fake",
  TC_SMS: "fake",
};

function useEnv(env: Record<string, string>): void {
  for (const key of ["TC_STAGE", "APP_ORIGIN", "TC_IDP", "TC_SMS", "TC_EPS"]) {
    vi.stubEnv(key, "");
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

const request = (path: string) => new Request(`http://localhost:3000${path}`);

beforeEach(() => resetFakeState());
afterEach(() => vi.unstubAllEnvs());

describe("GET /dev/idp/outbox", () => {
  it("answers 404 when the fake identity switch is off (a production-like config)", async () => {
    useEnv({
      TC_STAGE: "production",
      APP_ORIGIN: "https://cloud.example.com",
      NODE_ENV: "production",
    });
    getFakeState().emailCodes.set("a@example.test", {
      kind: "signup",
      code: "123456",
      issuedAtMs: 0,
    });
    const answer = await emailOutbox(request("/dev/idp/outbox?email=a%40example.test"));
    expect(answer.status).toBe(404);
    expect(await answer.text()).not.toContain("123456");
  });

  it("answers 404 even when the config itself is broken", async () => {
    useEnv({ TC_STAGE: "bogus" });
    expect((await emailOutbox(request("/dev/idp/outbox?email=a%40example.test"))).status).toBe(404);
  });

  it("answers the newest code with no-store in fake mode", async () => {
    useEnv(FAKE_ENV);
    getFakeState().emailCodes.set("a@example.test", {
      kind: "signup",
      code: "123456",
      issuedAtMs: 0,
    });
    const answer = await emailOutbox(request("/dev/idp/outbox?email=A%40Example.test"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({ kind: "signup", code: "123456" });
  });

  it("refuses an address that is not an address and answers 404 for an unknown one", async () => {
    useEnv(FAKE_ENV);
    expect((await emailOutbox(request("/dev/idp/outbox?email=nope"))).status).toBe(400);
    expect((await emailOutbox(request("/dev/idp/outbox"))).status).toBe(400);
    expect((await emailOutbox(request("/dev/idp/outbox?email=x%40example.test"))).status).toBe(404);
  });
});

describe("GET /dev/sms/outbox", () => {
  it("answers 404 when the fake SMS switch is off", async () => {
    useEnv({ ...FAKE_ENV, TC_SMS: "" });
    await getFakeSms().send("+8801712345678", "code 123456");
    const answer = await smsOutbox(request("/dev/sms/outbox?to=%2B8801712345678"));
    expect(answer.status).toBe(404);
  });

  it("answers 404 in staging and production", async () => {
    useEnv({
      TC_STAGE: "staging",
      APP_ORIGIN: "https://cloud.example.com",
      NODE_ENV: "production",
    });
    expect((await smsOutbox(request("/dev/sms/outbox?to=%2B8801712345678"))).status).toBe(404);
  });

  it("answers only the newest message to the number, in fake mode", async () => {
    useEnv(FAKE_ENV);
    const sms = getFakeSms();
    await sms.send("+8801712345678", "first 111111");
    await sms.send("+8801812345678", "other 222222");
    await sms.send("+8801712345678", "second 333333");
    const answer = await smsOutbox(request("/dev/sms/outbox?to=01712345678"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({ text: "second 333333" });
  });

  it("refuses a number that is not a Bangladeshi mobile number", async () => {
    useEnv(FAKE_ENV);
    expect((await smsOutbox(request("/dev/sms/outbox?to=12345"))).status).toBe(400);
    expect((await smsOutbox(request("/dev/sms/outbox"))).status).toBe(400);
  });
});
