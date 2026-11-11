import { describe, expect, it } from "vitest";
import { forbiddenWording, messageKeys, missingKeys } from "./message-checks.ts";

describe("messageKeys", () => {
  it("lists the dotted paths of the string leaves, sorted", () => {
    expect(messageKeys({ b: { z: "1", a: "2" }, a: "3", c: { d: { e: "4" } } })).toEqual([
      "a",
      "b.a",
      "b.z",
      "c.d.e",
    ]);
  });

  it("is empty for an empty tree", () => {
    expect(messageKeys({})).toEqual([]);
  });
});

describe("missingKeys", () => {
  const a = { x: "1", y: { p: "2", q: "3" } };
  const b = { x: "1", y: { p: "2" }, z: "9" };

  it("lists the keys of a that b lacks", () => {
    expect(missingKeys(a, b)).toEqual(["y.q"]);
  });

  it("works in the other direction", () => {
    expect(missingKeys(b, a)).toEqual(["z"]);
  });

  it("is empty for equal key sets", () => {
    expect(missingKeys(a, a)).toEqual([]);
  });
});

describe("forbiddenWording", () => {
  const rules = (text: string): string[] => forbiddenWording({ k: text }).map((f) => f.rule);

  it("passes the allowed wording", () => {
    expect(rules("Amazon Lightsail")).toEqual([]);
    expect(rules("100% AWS infrastructure. Built on Amazon Lightsail.")).toEqual([]);
    expect(rules("ap-southeast-1")).toEqual([]);
    expect(rules("৳১২,৩৪৫")).toEqual([]);
    expect(rules("Amazon Route 53")).toEqual([]);
    expect(rules("1234567890123")).toEqual([]);
  });

  it("aws-lightsail", () => {
    expect(rules("AWS Lightsail")).toContain("aws-lightsail");
    expect(rules("AWS-Lightsail")).toContain("aws-lightsail");
    expect(rules("aws lightsail")).toContain("aws-lightsail");
    expect(rules("AWSLightsail")).toContain("aws-lightsail");
  });

  it("powered-by-aws", () => {
    expect(rules("Powered by AWS")).toContain("powered-by-aws");
    expect(rules("powered  by aws")).toContain("powered-by-aws");
  });

  it("joined-mark", () => {
    expect(rules("AWSLightsail")).toContain("joined-mark");
    expect(rules("AmazonRoute53")).toContain("joined-mark");
    expect(rules("AWSRoute53")).toContain("joined-mark");
  });

  it("arn", () => {
    expect(rules("arn:aws:s3:::x")).toContain("arn");
  });

  it("account-id", () => {
    expect(rules("123456789012")).toContain("account-id");
    expect(rules("account 123456789012.")).toContain("account-id");
  });

  it("internal-name", () => {
    expect(rules("tc-vm-a1b2c3")).toContain("internal-name");
    expect(rules("TC-DB-ABCD1234")).toContain("internal-name");
  });

  it("names the key of each finding", () => {
    expect(forbiddenWording({ A: { b: "ok" }, C: { d: "AWS Lightsail" } })).toEqual([
      { key: "C.d", rule: "aws-lightsail" },
    ]);
  });

  it("reports every rule that a string breaks", () => {
    const found = forbiddenWording({ k: "AWSLightsail arn:aws:iam::1" });
    expect(found.map((f) => f.rule).sort()).toEqual(["arn", "aws-lightsail", "joined-mark"]);
  });
});
