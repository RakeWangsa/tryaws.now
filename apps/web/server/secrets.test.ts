import { describe, expect, it } from "vitest";
import { NOT_CONFIGURED, resourceSecrets } from "./secrets.ts";

describe("resourceSecrets", () => {
  it("reads the value of an SST linked secret", () => {
    const source = resourceSecrets({
      SST_RESOURCE_EpsHashKey: '{"type":"sst.sst.Secret","value":"k"}',
    });
    expect(source("EpsHashKey")).toBe("k");
  });

  it("gives undefined for a missing name, malformed JSON, a non-string and an empty value", () => {
    const source = resourceSecrets({
      SST_RESOURCE_EpsStoreId: "{not json",
      SST_RESOURCE_EpsUsername: '{"value":42}',
      SST_RESOURCE_EpsPassword: '{"value":""}',
      SST_RESOURCE_EpsMerchantId: '"just a string"',
      SST_RESOURCE_EpsLimitKey: "null",
    });
    expect(source("EpsHashKey")).toBeUndefined();
    expect(source("EpsStoreId")).toBeUndefined();
    expect(source("EpsUsername")).toBeUndefined();
    expect(source("EpsPassword")).toBeUndefined();
    expect(source("EpsMerchantId")).toBeUndefined();
    expect(source("EpsLimitKey")).toBeUndefined();
  });

  it("reads the two secrets of the SMS gateway (WPU-Z3)", () => {
    const source = resourceSecrets({
      SST_RESOURCE_SmsApiKey: '{"type":"sst.sst.Secret","value":"fake-sms-token"}',
      SST_RESOURCE_SmsSenderId: '{"type":"sst.sst.Secret","value":"FAKESENDER"}',
    });
    expect(source("SmsApiKey")).toBe("fake-sms-token");
    expect(source("SmsSenderId")).toBe("FAKESENDER");
    expect(resourceSecrets({})("SmsSenderId")).toBeUndefined();
  });

  it("the source is a function that reads the environment at the time of use", () => {
    const env: Record<string, string | undefined> = {};
    const source = resourceSecrets(env);
    expect(typeof source).toBe("function");
    expect(source("EpsHashKey")).toBeUndefined();
    env["SST_RESOURCE_EpsHashKey"] = '{"value":"late"}';
    expect(source("EpsHashKey")).toBe("late");
  });

  // WPU-Z11: scripts/golive/stage-secrets.sh stores this literal for an EPS value that the owner does
  // not have yet (SST needs a value for every declared secret). It is the same as no value.
  it("reads the placeholder not-configured as no value, whatever the name (WPU-Z11)", () => {
    const placeholder = '{"type":"sst.sst.Secret","value":"not-configured"}';
    const source = resourceSecrets({
      SST_RESOURCE_EpsMerchantId: placeholder,
      SST_RESOURCE_EpsPassword: placeholder,
      SST_RESOURCE_SmsApiKey: placeholder,
      SST_RESOURCE_EpsHashKey: '{"value":"not-configured-is-only-a-prefix-here"}',
    });
    expect(NOT_CONFIGURED).toBe("not-configured");
    expect(source("EpsMerchantId")).toBeUndefined();
    expect(source("EpsPassword")).toBeUndefined();
    expect(source("SmsApiKey")).toBeUndefined();
    expect(source("EpsHashKey")).toBe("not-configured-is-only-a-prefix-here");
  });

  it("holds no secret in a property of the source", () => {
    const source = resourceSecrets({ SST_RESOURCE_EpsHashKey: '{"value":"planted-k"}' });
    expect(Object.keys(source)).toEqual([]);
    expect(JSON.stringify(source)).toBeUndefined();
  });
});
