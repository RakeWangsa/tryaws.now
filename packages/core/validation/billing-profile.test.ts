import { expect, it } from "vitest";
import { BILLING_ADDRESS_MAX, BILLING_NAME_MAX, parseBillingProfile } from "./billing-profile";

const ok = (form: Record<string, unknown>) => {
  const r = parseBillingProfile(form);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.fields)}`);
  return r.value;
};
const fields = (form: Record<string, unknown>) => {
  const r = parseBillingProfile(form);
  if (r.ok) throw new Error("accepted");
  return r.fields;
};

it("an empty form clears the profile: every field is null", () => {
  const empty = {
    billingName: null,
    billingAddress: null,
    customerBin: null,
    customerNid: null,
  };
  expect(ok({})).toEqual(empty);
  expect(ok({ billingName: "  ", billingAddress: "", customerBin: " ", customerNid: "" })).toEqual(
    empty,
  );
});

it("a BIN is exactly 13 digits; spaces, hyphens and Bengali digits are normalised", () => {
  expect(ok({ customerBin: "1234567890123" }).customerBin).toBe("1234567890123");
  expect(ok({ customerBin: "123456789-0123" }).customerBin).toBe("1234567890123");
  expect(ok({ customerBin: "১২৩৪৫৬৭৮৯০১২৩" }).customerBin).toBe("1234567890123");
  for (const bad of ["123456789012", "12345678901234", "12345678901a3", "+234567890123"]) {
    expect(fields({ customerBin: bad })).toEqual({ customerBin: "invalid" });
  }
});

it("a NID is 10, 13 or 17 digits and nothing else", () => {
  for (const good of ["1234567890", "1234567890123", "12345678901234567"]) {
    expect(ok({ customerNid: good }).customerNid).toBe(good);
  }
  for (const bad of [
    "123456789",
    "12345678901",
    "123456789012345",
    "123456789012345678",
    "12a4567890",
  ]) {
    expect(fields({ customerNid: bad })).toEqual({ customerNid: "invalid" });
  }
});

it("a BIN and a NID together are refused: an invoice names one", () => {
  expect(fields({ customerBin: "1234567890123", customerNid: "1234567890" })).toEqual({
    customerBin: "conflict",
    customerNid: "conflict",
  });
});

it("the address: trimmed, whitespace (even a newline) collapsed, 5 to 300 code points", () => {
  expect(ok({ billingAddress: "  House 5,\n Road 3,   Dhanmondi, Dhaka " }).billingAddress).toBe(
    "House 5, Road 3, Dhanmondi, Dhaka",
  );
  expect(ok({ billingAddress: "বাড়ি ৫, সড়ক ৩, ধানমন্ডি, ঢাকা" }).billingAddress).toBe(
    "বাড়ি ৫, সড়ক ৩, ধানমন্ডি, ঢাকা",
  );
  expect(ok({ billingAddress: "a".repeat(BILLING_ADDRESS_MAX) }).billingAddress).toHaveLength(
    BILLING_ADDRESS_MAX,
  );
  expect(fields({ billingAddress: "a".repeat(BILLING_ADDRESS_MAX + 1) })).toEqual({
    billingAddress: "too_long",
  });
  expect(fields({ billingAddress: "Dhk" })).toEqual({ billingAddress: "too_short" });
});

it("the address refuses control and format characters and markup", () => {
  for (const bad of [
    "House 5\u0000 Road",
    "House 5\u0007 Road",
    "House 5 ​ Road",
    "House 5 ‮ Road",
    "House <b>5</b> Road",
  ]) {
    expect(fields({ billingAddress: bad })).toEqual({ billingAddress: "invalid" });
  }
});

it("the billing name: 2 to 120 code points, & and quotes allowed (companies), markup and controls not", () => {
  expect(ok({ billingName: "  Rahim   & Sons Ltd. " }).billingName).toBe("Rahim & Sons Ltd.");
  expect(ok({ billingName: "x".repeat(BILLING_NAME_MAX) }).billingName).toHaveLength(
    BILLING_NAME_MAX,
  );
  expect(fields({ billingName: "x".repeat(BILLING_NAME_MAX + 1) })).toEqual({
    billingName: "too_long",
  });
  expect(fields({ billingName: "R" })).toEqual({ billingName: "too_short" });
  expect(fields({ billingName: "<script>" })).toEqual({ billingName: "invalid" });
  expect(fields({ billingName: "Rahim\u0000" })).toEqual({ billingName: "invalid" });
});

it("a value that is not text is invalid, never coerced", () => {
  expect(fields({ billingAddress: 12345678, customerBin: 1234567890123, billingName: {} })).toEqual(
    {
      billingAddress: "invalid",
      customerBin: "invalid",
      billingName: "invalid",
    },
  );
});

it("a huge input is refused without work", () => {
  expect(fields({ billingAddress: "a".repeat(100_000) })).toEqual({ billingAddress: "too_long" });
});

it("an unknown key is ignored and never carried on", () => {
  expect(ok({ billingName: "Rahim", email: "x@y.z", customerId: "abc" })).toEqual({
    billingName: "Rahim",
    billingAddress: null,
    customerBin: null,
    customerNid: null,
  });
});
