import { describe, expect, it } from "vitest";
import { cdnConfigOf } from "./cdn-view.ts";

const ORIGIN = "0190aaaa-0000-7000-8000-0000000000a1";

describe("cdnConfigOf", () => {
  it("reads the name, the origin, the cache behavior and a plain default domain, field by field", () => {
    expect(
      cdnConfigOf({
        displayName: "site",
        originId: ORIGIN,
        cacheBehavior: "dont-cache",
        defaultDomain: "d1a2b3.cloudfront.net",
        accountId: "123456789012",
        awsName: "tc-cdn-0123456789abcdef",
      }),
    ).toEqual({
      name: "site",
      originId: ORIGIN,
      cacheBehavior: "dont-cache",
      defaultDomain: "d1a2b3.cloudfront.net",
    });
  });

  it("drops what is not plain: a domain with markup, an origin that is no id, an odd cache word", () => {
    const facts = cdnConfigOf({
      displayName: 5,
      originId: "<script>",
      cacheBehavior: "everything",
      defaultDomain: "<b>x</b>.example",
    });
    expect(facts).toEqual({
      name: "",
      originId: null,
      cacheBehavior: "cache",
      defaultDomain: null,
    });
    expect(cdnConfigOf(null).defaultDomain).toBeNull();
  });
});
