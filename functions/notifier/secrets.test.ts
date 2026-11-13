import { expect, it } from "vitest";
import { linkedSecret } from "./secrets";

// WPU-Z3: the reader of the two SMS secrets. Obviously fake values (R3).
it("reads the value of an SST linked secret", () => {
  const env = {
    SST_RESOURCE_SmsApiKey: '{"type":"sst.sst.Secret","value":"fake-notifier-token"}',
    SST_RESOURCE_SmsSenderId: '{"type":"sst.sst.Secret","value":"FAKESENDER"}',
  };
  expect(linkedSecret(env, "SmsApiKey")).toBe("fake-notifier-token");
  expect(linkedSecret(env, "SmsSenderId")).toBe("FAKESENDER");
});

it("gives undefined for a missing variable, malformed JSON, a value that is not a string and an empty value", () => {
  for (const raw of [
    undefined,
    "",
    "{not json",
    '"just text"',
    "null",
    "[]",
    '{"value":42}',
    '{"value":""}',
    "{}",
  ]) {
    expect(linkedSecret({ SST_RESOURCE_SmsApiKey: raw }, "SmsApiKey"), String(raw)).toBeUndefined();
  }
});

it("reads only the variable of the name it is asked for", () => {
  const env = { SST_RESOURCE_SmsSenderId: '{"value":"FAKESENDER"}' };
  expect(linkedSecret(env, "SmsApiKey")).toBeUndefined();
});
