import { expect, it } from "vitest";
import { DETAIL_KEYS, projectDetails } from "../repositories/admin/reconciliation";

// The projection of discrepancies.details for the /reconciliation screen (16.13, R14). Pure.
it("keeps the allow-listed keys in the fixed order with plain text values", () => {
  expect(
    projectDetails({
      note: "above the plan",
      region: "ap-southeast-1",
      resourceId: "0191a000-0000-7000-8000-0000000000aa",
      count: 3,
      flag: true,
    }),
  ).toEqual([
    { key: "resourceId", value: "0191a000-0000-7000-8000-0000000000aa" },
    { key: "region", value: "ap-southeast-1" },
    { key: "count", value: "3" },
    { key: "note", value: "above the plan" },
  ]);
});

it("drops ARNs, 12-digit account ids, long or control text, nested values and unknown keys", () => {
  const out = projectDetails({
    resourceId: "arn:aws:lightsail:ap-southeast-1:123456789012:Instance/x",
    operationId: "acct 123456789012 failed",
    paymentId: "x".repeat(201),
    transactionId: "line\nbreak",
    customerId: { nested: 1 },
    family: ["a"],
    region: null,
    password: "secret",
    token: "t",
    note: "ARN:aws:iam::1:role/x",
  });
  expect(out).toEqual([]);
  expect(JSON.stringify(out)).not.toMatch(/arn|secret|123456789012/i);
});

it("keeps a longer digit run (not an account id) and refuses non-object details", () => {
  expect(projectDetails({ expectedMinor: "123456789012" })).toEqual([]);
  expect(projectDetails({ expectedMinor: "1234567890123" })).toEqual([
    { key: "expectedMinor", value: "1234567890123" },
  ]);
  expect(projectDetails({ expectedMinor: "12345678901" })).toEqual([
    { key: "expectedMinor", value: "12345678901" },
  ]);
  for (const bad of [null, undefined, "x", 3, [], [{ note: "a" }]]) {
    expect(projectDetails(bad)).toEqual([]);
  }
  expect(new Set(DETAIL_KEYS).size).toBe(DETAIL_KEYS.length);
});
