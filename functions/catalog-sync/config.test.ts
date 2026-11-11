import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const BASE = { CATALOG_POOL_ACCOUNT_ID: "111122223333" };

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a throw");
}

describe("catalog-sync readConfig", () => {
  it("reads the defaults", () => {
    expect(readConfig(BASE)).toEqual({
      poolAccountId: "111122223333",
      dnsAccountId: null,
      dnsExternalId: null,
      regions: ["ap-southeast-1"],
      syncTlds: false,
    });
  });

  it("a missing pool account throws and names the variable", () => {
    expect(messageOf(() => readConfig({}))).toContain("CATALOG_POOL_ACCOUNT_ID");
  });

  it.each(["12345", "12345678901x", "1234567890123", ""])("rejects %j without the value", (bad) => {
    const message = messageOf(() => readConfig({ CATALOG_POOL_ACCOUNT_ID: bad }));
    expect(message).toContain("CATALOG_POOL_ACCOUNT_ID");
    if (bad !== "") expect(message).not.toContain(bad);
  });

  it("an unknown Region throws, no silent drop, and the text holds no value", () => {
    const message = messageOf(() =>
      readConfig({ ...BASE, CATALOG_REGIONS: "ap-southeast-1,eu-west-1" }),
    );
    expect(message).toContain("CATALOG_REGIONS");
    expect(message).not.toContain("eu-west-1");
  });

  it("trims the Region list and keeps its order", () => {
    expect(readConfig({ ...BASE, CATALOG_REGIONS: " ap-south-1 , us-east-1" }).regions).toEqual([
      "ap-south-1",
      "us-east-1",
    ]);
  });

  it("an empty or duplicated Region list throws", () => {
    expect(messageOf(() => readConfig({ ...BASE, CATALOG_REGIONS: " , " }))).toContain(
      "CATALOG_REGIONS",
    );
    expect(
      messageOf(() => readConfig({ ...BASE, CATALOG_REGIONS: "ap-south-1,ap-south-1" })),
    ).toContain("CATALOG_REGIONS");
  });

  it("both DNS values turn the TLD step on; one alone throws", () => {
    expect(
      readConfig({
        ...BASE,
        CATALOG_DNS_ACCOUNT_ID: "444455556666",
        CATALOG_DNS_EXTERNAL_ID: "dns-ext-1",
      }),
    ).toMatchObject({ dnsAccountId: "444455556666", dnsExternalId: "dns-ext-1", syncTlds: true });
    expect(
      messageOf(() => readConfig({ ...BASE, CATALOG_DNS_ACCOUNT_ID: "444455556666" })),
    ).toContain("CATALOG_DNS_EXTERNAL_ID");
    expect(
      messageOf(() => readConfig({ ...BASE, CATALOG_DNS_EXTERNAL_ID: "dns-ext-1" })),
    ).toContain("CATALOG_DNS_ACCOUNT_ID");
  });

  it("a malformed DNS account id throws without either value", () => {
    const message = messageOf(() =>
      readConfig({
        ...BASE,
        CATALOG_DNS_ACCOUNT_ID: "44445555666x",
        CATALOG_DNS_EXTERNAL_ID: "dns-ext-1",
      }),
    );
    expect(message).toContain("CATALOG_DNS_ACCOUNT_ID");
    expect(message).not.toContain("44445555666x");
    expect(message).not.toContain("dns-ext-1");
  });

  it("ignores every other variable", () => {
    expect(readConfig({ ...BASE, TC_ENV: "production", CATALOG_SECRET: "x" })).toEqual(
      readConfig(BASE),
    );
  });
});
