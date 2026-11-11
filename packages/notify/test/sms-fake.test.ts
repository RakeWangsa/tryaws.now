import { afterEach, expect, it, vi } from "vitest";
import { InMemorySmsProvider } from "../sms/fake";

afterEach(() => vi.unstubAllEnvs());
const TO = "+8801712345678";

it("records what was sent, numbers the messages, and answers ok", async () => {
  const sms = new InMemorySmsProvider();
  expect(await sms.send(TO, "hello")).toEqual({ ok: true, messageId: "fake-1" });
  expect(await sms.send(TO, "again")).toEqual({ ok: true, messageId: "fake-2" });
  expect(sms.sent).toEqual([
    { to: TO, text: "hello", messageId: "fake-1" },
    { to: TO, text: "again", messageId: "fake-2" },
  ]);
  sms.reset();
  expect(sms.sent).toEqual([]);
});

it("reset clears the recorded messages, the queued failures and the numbering", async () => {
  const sms = new InMemorySmsProvider();
  await sms.send(TO, "a");
  sms.failNext("hang", 3);
  sms.reset();
  expect(await sms.send(TO, "b")).toEqual({ ok: true, messageId: "fake-1" });
});

it("refuses what a gateway would refuse: a number that is not E.164, an empty text, a text over 160 characters", async () => {
  const sms = new InMemorySmsProvider();
  for (const [to, text] of [
    ["01712345678", "x"],
    ["+0123", "x"],
    [TO, ""],
    [TO, "x".repeat(161)],
  ] as const) {
    expect(await sms.send(to, text)).toEqual({ ok: false, reason: "rejected" });
  }
  expect(sms.sent).toEqual([]);
});

it("failNext fails the next calls in the chosen way, then the provider recovers", async () => {
  const sms = new InMemorySmsProvider();
  sms.failNext("rejected");
  expect(await sms.send(TO, "a")).toEqual({ ok: false, reason: "rejected" });
  sms.failNext("unavailable", 2);
  expect(await sms.send(TO, "b")).toEqual({ ok: false, reason: "unavailable" });
  expect(await sms.send(TO, "c")).toEqual({ ok: false, reason: "unavailable" });
  expect(await sms.send(TO, "d")).toMatchObject({ ok: true });
  expect(sms.sent.map((m) => m.text)).toEqual(["d"]);
});

it("the throw mode throws an error that echoes the number and the text; the hang mode never settles", async () => {
  const sms = new InMemorySmsProvider();
  sms.failNext("throw");
  await expect(sms.send(TO, "code 123456")).rejects.toThrow(
    `gateway failed for ${TO}: code 123456`,
  );
  sms.failNext("hang");
  const outcome = await Promise.race([
    sms.send(TO, "a").then(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 30)),
  ]);
  expect(outcome).toBe("pending");
});

it("it refuses to be built unless NODE_ENV is test or development: production and an unset value both throw", () => {
  for (const value of ["production", "", "staging"]) {
    vi.stubEnv("NODE_ENV", value);
    expect(() => new InMemorySmsProvider(), value).toThrow(
      "InMemorySmsProvider is for tests and local runs only",
    );
  }
  for (const value of ["test", "development"]) {
    vi.stubEnv("NODE_ENV", value);
    expect(() => new InMemorySmsProvider(), value).not.toThrow();
  }
});
