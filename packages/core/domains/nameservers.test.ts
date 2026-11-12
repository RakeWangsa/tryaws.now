import { describe, expect, it } from "vitest";
import { parseNameServers, splitNameServers } from "./nameservers";

// WPU-B2: the name servers a customer may set on a registered domain (UpdateDomainNameservers). Pure.

describe("parseNameServers", () => {
  it("accepts 2 to 8 distinct host names and returns them lower case without a trailing dot", () => {
    expect(parseNameServers(["NS1.Example.net", "ns2.example.net."])).toEqual({
      ok: true,
      value: ["ns1.example.net", "ns2.example.net"],
    });
    const eight = Array.from({ length: 8 }, (_, i) => `ns${i}.example.net`);
    expect(parseNameServers(eight)).toMatchObject({ ok: true });
  });

  it("refuses everything else with one code", () => {
    const eight = Array.from({ length: 9 }, (_, i) => `ns${i}.example.net`);
    for (const bad of [
      null,
      undefined,
      "ns1.example.net,ns2.example.net",
      [],
      ["ns1.example.net"],
      ["ns1.example.net", "NS1.example.net"],
      ["ns1.example.net", "ns1.example.net."],
      ["ns1.example.net", "10.0.0.1"],
      ["ns1.example.net", "1.2.3.4.5"],
      ["ns1.example.net", "bad host.example.net"],
      ["ns1.example.net", "-bad.example.net"],
      ["ns1.example.net", "ns2"],
      ["ns1.example.net", `${"x".repeat(64)}.example.net`],
      ["ns1.example.net", `${"x.".repeat(130)}net`],
      ["ns1.example.net", 5],
      ["ns1.example.net", "ns2.example.net\nns3.example.net"],
      eight,
    ]) {
      expect(parseNameServers(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        error: "validation",
        fields: { nameServers: "invalid" },
      });
    }
  });
});

describe("splitNameServers", () => {
  it("splits a form text on lines, commas and spaces and drops empty parts", () => {
    expect(splitNameServers("ns1.example.net\r\nns2.example.net, ns3.example.net  \n\n")).toEqual([
      "ns1.example.net",
      "ns2.example.net",
      "ns3.example.net",
    ]);
    expect(splitNameServers("")).toEqual([]);
  });
});
