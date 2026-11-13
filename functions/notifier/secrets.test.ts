import { envLinks, sstLinks } from "@tc/db/links";
import { expect, it } from "vitest";
import { linkedSecret } from "./secrets";

// WPU-Z3: the reader of the two SMS secrets. Obviously fake values (R3). The links of these tests come
// from the SST_RESOURCE_<Name> variables of an environment object (envLinks); the run-time path through
// the SST SDK is secrets-sst.test.ts (WPU-Z15).
it("reads the value of an SST linked secret", () => {
  const env = {
    SST_RESOURCE_SmsApiKey: '{"type":"sst.sst.Secret","value":"fake-notifier-token"}',
    SST_RESOURCE_SmsSenderId: '{"type":"sst.sst.Secret","value":"FAKESENDER"}',
  };
  expect(linkedSecret(envLinks(env), "SmsApiKey")).toBe("fake-notifier-token");
  expect(linkedSecret(envLinks(env), "SmsSenderId")).toBe("FAKESENDER");
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
    expect(
      linkedSecret(envLinks({ SST_RESOURCE_SmsApiKey: raw }), "SmsApiKey"),
      String(raw),
    ).toBeUndefined();
  }
});

it("reads only the variable of the name it is asked for", () => {
  const env = { SST_RESOURCE_SmsSenderId: '{"value":"FAKESENDER"}' };
  expect(linkedSecret(envLinks(env), "SmsApiKey")).toBeUndefined();
});

it("the SST SDK, with nothing linked, gives undefined and not an error (WPU-Z15)", () => {
  // The SDK's own Resource throws for a name that is not linked (packages/db/test/links.test.ts); the
  // reader must not pass it on.
  expect(linkedSecret(sstLinks, "SmsApiKey")).toBeUndefined();
  expect(linkedSecret(sstLinks, "SmsSenderId")).toBeUndefined();
});

// Final review M2: SmsApiKey and SmsSenderId may stay on the placeholder not-configured (SMS off). The
// placeholder is never a value: it would otherwise be sent to Gennet as a token or a sender id.
it("reads the placeholder not-configured as no value", () => {
  const placeholder = '{"type":"sst.sst.Secret","value":"not-configured"}';
  const env = { SST_RESOURCE_SmsApiKey: placeholder, SST_RESOURCE_SmsSenderId: placeholder };
  expect(linkedSecret(envLinks(env), "SmsApiKey")).toBeUndefined();
  expect(linkedSecret(envLinks(env), "SmsSenderId")).toBeUndefined();
});
