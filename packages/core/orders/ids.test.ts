import { describe, expect, it } from "vitest";
import { childId, draftHash, orderIdFor } from "./ids";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CUSTOMER_A = "0190aaaa-0000-7000-8000-000000000001";
const CUSTOMER_B = "0190aaaa-0000-7000-8000-000000000002";

describe("draftHash", () => {
  it("is 43 characters of the base64url alphabet and stable", () => {
    const h = draftHash("some.token");
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(draftHash("some.token")).toBe(h);
    expect(draftHash("other.token")).not.toBe(h);
  });
});

describe("orderIdFor", () => {
  const hash = draftHash("t1");
  it("is a stable UUID with version nibble 5 and the variant bits", () => {
    const id = orderIdFor(CUSTOMER_A, hash);
    expect(id).toMatch(UUID);
    expect(id[14]).toBe("5");
    expect("89ab").toContain(id[19]);
    expect(orderIdFor(CUSTOMER_A, hash)).toBe(id);
  });
  it("differs per customer and per hash", () => {
    expect(orderIdFor(CUSTOMER_B, hash)).not.toBe(orderIdFor(CUSTOMER_A, hash));
    expect(orderIdFor(CUSTOMER_A, draftHash("t2"))).not.toBe(orderIdFor(CUSTOMER_A, hash));
  });
});

describe("childId", () => {
  const order = orderIdFor(CUSTOMER_A, draftHash("t1"));
  it("differs per label and per order, and is a UUID", () => {
    const r = childId(order, "resource");
    const s = childId(order, "subscription");
    expect(r).toMatch(UUID);
    expect(s).toMatch(UUID);
    expect(r).not.toBe(s);
    expect(r).not.toBe(order);
    expect(childId(orderIdFor(CUSTOMER_B, draftHash("t1")), "resource")).not.toBe(r);
    expect(childId(order, "resource")).toBe(r);
  });
});

describe("fixed derivations", () => {
  it("pins fixed inputs so a change of the derivation is a visible diff", () => {
    const hash = draftHash("fixed-token-1");
    const order = orderIdFor(CUSTOMER_A, hash);
    expect({
      hash,
      order,
      resource: childId(order, "resource"),
      subscription: childId(order, "subscription"),
    }).toEqual({
      hash: "TKF_QzL2mEULLfHbncwDGd48hL6sX4jPk6zao5XOhbM",
      order: "5e4d000e-17cc-5818-8d59-45188ac4cdd2",
      resource: "bb0fd89e-3abd-5346-b35c-7e61b1cd0f2c",
      subscription: "ba203c14-283e-56b4-80f2-8de9d372e54b",
    });
  });
});
