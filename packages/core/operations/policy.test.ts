import { expect, it } from "vitest";
import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
  decideFailure,
  decideRefusal,
  lastErrorText,
  refundedOnFailure,
} from "./policy";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const after = (s: number) => new Date(NOW.getTime() + s * 1000);
const retryable = {
  code: "upstream_unavailable",
  retryable: true,
  poolFull: false,
  awsErrorName: "ServiceException",
} as const;

it("the numbers of 10.1", () => {
  expect(MAX_ATTEMPTS).toBe(5);
  expect([...RETRY_DELAYS_SECONDS]).toEqual([60, 120, 240, 480]);
  expect(LEASE_SECONDS).toBe(120);
});

it.each([
  [0, 60],
  [1, 120],
  [2, 240],
  [3, 480],
])("a retryable error after %i failed attempts waits %i seconds", (attempts, seconds) => {
  expect(decideFailure({ kind: "reboot", attempts, now: NOW, facts: retryable })).toEqual({
    to: "waiting",
    attempts: attempts + 1,
    nextRunAt: after(seconds),
    lastError: "upstream_unavailable:ServiceException",
  });
});

it("the fifth failure needs attention, and so does the first failure after an admin retry", () => {
  for (const attempts of [4, 5, 9]) {
    expect(decideFailure({ kind: "create", attempts, now: NOW, facts: retryable })).toEqual({
      to: "needs_attention",
      attempts: attempts + 1,
      lastError: "upstream_unavailable:ServiceException",
    });
  }
});

it("an attempt count that has no delay (negative, fractional, NaN) needs attention instead of crashing (R16)", () => {
  for (const attempts of [-1, 1.5, Number.NaN]) {
    expect(decideFailure({ kind: "reboot", attempts, now: NOW, facts: retryable }).to).toBe(
      "needs_attention",
    );
  }
});

it("a full pool needs attention at once, even for a create", () => {
  const facts = {
    code: "capacity_full",
    retryable: true,
    poolFull: true,
    awsErrorName: "ServiceQuotaExceededException",
  } as const;
  expect(decideFailure({ kind: "create", attempts: 0, now: NOW, facts })).toEqual({
    to: "needs_attention",
    attempts: 1,
    lastError: "capacity_full:ServiceQuotaExceededException",
  });
});

it("an error that can never succeed fails a create and a domain renewal, and only stops every other kind", () => {
  const facts = {
    code: "validation",
    retryable: false,
    poolFull: false,
    awsErrorName: "InvalidInputException",
  } as const;
  // WPU-Z13: a renewal the registry refuses reaches failed like a create, so its charge goes back (10.1).
  for (const kind of ["create", "renew_domain"] as const) {
    expect(decideFailure({ kind, attempts: 2, now: NOW, facts })).toEqual({
      to: "failed",
      attempts: 3,
      lastError: "validation:InvalidInputException",
    });
  }
  for (const kind of [
    "reboot",
    "destroy",
    "resume",
    "attach_disk",
    "set_name_servers",
    "resend_verification",
    "scale_container",
  ] as const) {
    expect(decideFailure({ kind, attempts: 2, now: NOW, facts }).to).toBe("needs_attention");
  }
});

it("a domain renewal is retried like any kind, and an admin decides after the fifth failure (10.1)", () => {
  expect(decideFailure({ kind: "renew_domain", attempts: 0, now: NOW, facts: retryable })).toEqual({
    to: "waiting",
    attempts: 1,
    nextRunAt: after(60),
    lastError: "upstream_unavailable:ServiceException",
  });
  expect(decideFailure({ kind: "renew_domain", attempts: 4, now: NOW, facts: retryable }).to).toBe(
    "needs_attention",
  );
});

it("the kinds whose failure gives money back: a create and a domain renewal, nothing else", () => {
  expect(refundedOnFailure("create")).toBe(true);
  expect(refundedOnFailure("renew_domain")).toBe(true);
  for (const kind of ["reboot", "destroy", "cleanup_failed_create", "reject_operation", "x", ""]) {
    expect(refundedOnFailure(kind), kind).toBe(false);
  }
});

it("last_error holds a code and a plain error name, never other text", () => {
  expect(lastErrorText({ ...retryable, awsErrorName: null })).toBe("upstream_unavailable");
  expect(lastErrorText({ ...retryable, awsErrorName: "bad name <x@example.test>" })).toBe(
    "upstream_unavailable",
  );
  expect(lastErrorText({ ...retryable, awsErrorName: "A".repeat(65) })).toBe(
    "upstream_unavailable",
  );
  expect(
    lastErrorText({ code: "lease_expired", retryable: true, poolFull: false, awsErrorName: null }),
  ).toBe("lease_expired");
});

it("a refusal needs attention, keeps the attempt count and records the code", () => {
  expect(decideRefusal("approval_flag_missing", 0)).toEqual({
    to: "needs_attention",
    attempts: 0,
    lastError: "approval_flag_missing",
  });
  expect(decideRefusal("no_adapter", 3).attempts).toBe(3);
});
