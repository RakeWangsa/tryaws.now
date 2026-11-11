import { describe, expect, it } from "vitest";
import { bucketConfigOf, bucketDestroyOpen, bucketNameOf, requestsOf } from "./bucket-view.ts";

const ID = "01a1c79b-17da-76c9-9766-a84e943a8987";

describe("bucketConfigOf", () => {
  it("shows the generated bucket name (U6), never the typed name, and builds the address from checked parts", () => {
    const facts = bucketConfigOf(ID, "ap-southeast-1", {
      displayName: "My <b>files</b>",
      awsName: "tc-bucket-0000000000000000",
      accountId: "123456789012",
    });
    expect(facts.bucketName).toBe("tc-bucket-9766a84e943a8987");
    expect(facts.address).toBe(
      "https://tc-bucket-9766a84e943a8987.s3.ap-southeast-1.amazonaws.com",
    );
    // The stored AWS name field is ignored: the name is a function of the id (R11).
    expect(JSON.stringify(facts)).not.toContain("0000000000000000");
    expect(JSON.stringify(facts)).not.toContain("123456789012");
  });

  it("has no address for an odd region or an id that is not a platform id", () => {
    expect(bucketConfigOf(ID, "x/../y", {}).address).toBeNull();
    expect(bucketConfigOf(ID, null, {}).address).toBeNull();
    expect(bucketNameOf("not-an-id")).toBeNull();
    expect(bucketConfigOf("not-an-id", "ap-southeast-1", {}).address).toBeNull();
  });

  it("reads the access mode only when it is one of the two words", () => {
    expect(bucketConfigOf(ID, null, { accessMode: "public" }).accessMode).toBe("public");
    expect(bucketConfigOf(ID, null, { accessMode: "private" }).accessMode).toBe("private");
    expect(bucketConfigOf(ID, null, { accessMode: "open" }).accessMode).toBeNull();
    expect(bucketConfigOf(ID, null, null).accessMode).toBeNull();
  });
});

describe("requestsOf", () => {
  const op = (kind: string, n: number) => ({
    id: `id${n}`,
    resourceId: ID,
    kind,
    state: "succeeded",
    step: null,
    needsApproval: false,
    createdAt: new Date(2026, 10, n),
  });
  it("keeps only access and key requests, at most five, with no payload", () => {
    const list = requestsOf([
      op("create", 1),
      op("set_bucket_access", 2),
      op("delete_access_key", 3),
      ...[4, 5, 6, 7, 8].map((n) => op("set_bucket_access", n)),
    ]);
    expect(list).toHaveLength(5);
    expect(list.map((r) => r.kind)).toEqual(["access", "key", "access", "access", "access"]);
    expect(Object.keys(list[0] as object).sort()).toEqual(["createdAt", "id", "kind", "state"]);
  });
});

describe("bucketDestroyOpen", () => {
  it("is what the lifecycle guard says today: closed, because `bucket` is on neither list", () => {
    expect(bucketDestroyOpen()).toBe(false);
  });
});
