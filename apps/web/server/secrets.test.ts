import { describe, expect, it } from "vitest";
import { resourceSecrets } from "./secrets.ts";

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

  it("holds no secret in a property of the source", () => {
    const source = resourceSecrets({ SST_RESOURCE_EpsHashKey: '{"value":"planted-k"}' });
    expect(Object.keys(source)).toEqual([]);
    expect(JSON.stringify(source)).toBeUndefined();
  });
});
