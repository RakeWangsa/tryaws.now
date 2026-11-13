import { describe, expect, it } from "vitest";
import {
  REGISTRY_UNRENEWED_ERROR,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
  decideFailure,
  decideRefusal,
  lastErrorText,
  refundedOnFailure,
  registryHoldsRenewal,
  type FailureFacts,
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

it("an error that can never succeed fails a create and a domain renewal the registry does not hold yet, and only stops every other kind", () => {
  const facts = {
    code: "validation",
    retryable: false,
    poolFull: false,
    awsErrorName: "InvalidInputException",
  } as const;
  // WPU-Z13: a renewal refused at step null (only reads, nothing sent to the registry) reaches failed like a
  // create, so its charge goes back (10.1). A create fails at any step. (Review round 2: a renewal at any other step
  // may be at the registry, below.)
  for (const [kind, step] of [
    ["create", null],
    ["create", "poll"],
    ["create", "submit"],
    ["renew_domain", null],
  ] as const) {
    expect(decideFailure({ kind, step, attempts: 2, now: NOW, facts })).toEqual({
      to: "failed",
      attempts: 3,
      lastError: "validation:InvalidInputException",
    });
  }
  expect(decideFailure({ kind: "create", attempts: 2, now: NOW, facts }).to).toBe("failed");
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

// WPU-Z13 review round 1: once RenewDomain was accepted (the adapter moved to `poll` with the registry's operation
// id) the registry holds a renewal that TiCON pays for and that may still complete. Only the registry's own answer
// that it failed (the adapter's `conflict`, no AWS error name) gives the charge back; anything else stops for a person.
describe("a domain renewal the registry holds (step poll)", () => {
  const final = (code: string, awsErrorName: string | null = null) =>
    ({ code, retryable: false, poolFull: false, awsErrorName }) as Parameters<
      typeof decideFailure
    >[0]["facts"];

  it("a poll that gave up after three days, a lost operation id or a bad answer stops in needs_attention: no money moves", () => {
    for (const facts of [
      final("upstream_unavailable"),
      final("internal"),
      final("validation", "InvalidInput"),
      final("not_found", "InvalidInput"),
      // An AWS error of a read at this step says nothing about the renewal, even when it maps to conflict.
      final("conflict", "OperationLimitExceeded"),
    ]) {
      expect(
        decideFailure({ kind: "renew_domain", step: "poll", attempts: 0, now: NOW, facts }),
        facts.code,
      ).toEqual({
        to: "needs_attention",
        attempts: 1,
        lastError: facts.awsErrorName === null ? facts.code : `${facts.code}:${facts.awsErrorName}`,
      });
    }
  });

  // WPU-Y2 fix round 1: the registry's FAILED answer for the exact saved RenewDomain operation (the adapter's
  // `registry_failed`) is final "not renewed": failed, with the refund. ERROR and a give-up with the expiry unchanged
  // (`registry_unrenewed`), and a conflict without that verdict, stop in needs_attention.
  it("the registry's FAILED answer at step poll (registry_failed) fails it: the charge goes back", () => {
    expect(
      decideFailure({
        kind: "renew_domain",
        step: "poll",
        attempts: 3,
        now: NOW,
        facts: { ...final("conflict"), registryVerdict: "failed" },
      }),
    ).toEqual({ to: "failed", attempts: 4, lastError: "conflict:registry_failed" });
  });

  it("ERROR or a give-up with the expiry unchanged (registry_unrenewed), or a bare conflict: needs attention, no refund", () => {
    expect(
      decideFailure({
        kind: "renew_domain",
        step: "poll",
        attempts: 0,
        now: NOW,
        facts: { ...final("upstream_unavailable"), registryVerdict: "unrenewed" },
      }),
    ).toEqual({ to: "needs_attention", attempts: 1, lastError: REGISTRY_UNRENEWED_ERROR });
    expect(
      decideFailure({
        kind: "renew_domain",
        step: "poll",
        attempts: 0,
        now: NOW,
        facts: final("conflict"),
      }).to,
    ).toBe("needs_attention");
    // the verdict counts only at poll and only with conflict
    expect(
      decideFailure({
        kind: "renew_domain",
        step: "poll",
        attempts: 0,
        now: NOW,
        facts: { ...final("upstream_unavailable"), registryVerdict: "failed" },
      }).to,
    ).toBe("needs_attention");
    expect(
      decideFailure({
        kind: "renew_domain",
        step: "start",
        attempts: 0,
        now: NOW,
        facts: { ...final("conflict"), registryVerdict: "failed" },
      }).to,
    ).toBe("needs_attention");
  });

  it("a step that is not known is taken as held (R16): nothing fails it", () => {
    expect(
      decideFailure({ kind: "renew_domain", attempts: 0, now: NOW, facts: final("validation") }).to,
    ).toBe("needs_attention");
    expect(
      decideFailure({ kind: "renew_domain", attempts: 0, now: NOW, facts: final("conflict") }).to,
    ).toBe("needs_attention");
  });

  it("an error that passes still waits, and the fifth failure needs attention, as for any kind", () => {
    const step = "poll";
    expect(
      decideFailure({ kind: "renew_domain", step, attempts: 0, now: NOW, facts: retryable }),
    ).toEqual({
      to: "waiting",
      attempts: 1,
      nextRunAt: after(60),
      lastError: "upstream_unavailable:ServiceException",
    });
    expect(
      decideFailure({ kind: "renew_domain", step, attempts: 4, now: NOW, facts: retryable }).to,
    ).toBe("needs_attention");
  });

  it("is a domain renewal at any step but null (submit, poll, or a step that is not known: R16), nothing else", () => {
    for (const step of ["submit", "poll", "start", "adopt", "Poll", ""]) {
      expect(registryHoldsRenewal("renew_domain", step), step).toBe(true);
    }
    expect(registryHoldsRenewal("renew_domain", null)).toBe(false);
    for (const kind of ["create", "set_name_servers", "resend_verification", "reboot", ""]) {
      expect(registryHoldsRenewal(kind, "poll"), kind).toBe(false);
      expect(registryHoldsRenewal(kind, "submit"), kind).toBe(false);
    }
  });

  it("a final error at a step that is not known gives nothing back without the registry's refusal (R16)", () => {
    const facts = { ...final("validation", "InvalidInput"), mayHaveActed: false };
    expect(
      decideFailure({
        kind: "renew_domain",
        step: "start",
        attempts: 0,
        lastError: null,
        now: NOW,
        facts,
      }).to,
    ).toBe("needs_attention");
  });
});

// WPU-Z13 review round 2: RenewDomain is sent only at step `submit`, which the adapter writes on its own before the
// call. A RenewDomain that may have reached the registry (a time-out, a reset connection, a 5xx after the request
// was sent: AwsError.mayHaveActed) leaves the renewal at `submit`, not at `poll`, so `submit` is held too: a final
// error gives the charge back only when it proves that nothing was sent, in this run and in every earlier one.
describe("a domain renewal at step submit (RenewDomain may have been sent)", () => {
  const facts = (over: Partial<FailureFacts>): FailureFacts => ({
    code: "conflict",
    retryable: false,
    poolFull: false,
    awsErrorName: "TLDRulesViolation",
    mayHaveActed: false,
    ...over,
  });
  const at = (f: FailureFacts, attempts = 0, lastError: string | null | undefined = null) =>
    decideFailure({
      kind: "renew_domain",
      step: "submit",
      attempts,
      ...(lastError !== undefined && { lastError }),
      now: NOW,
      facts: f,
    });

  it("a may-have-acted error of the submit step stops in needs_attention: no refund", () => {
    for (const f of [
      facts({
        code: "upstream_unavailable",
        awsErrorName: "ServiceUnavailable",
        mayHaveActed: true,
      }),
      facts({ code: "internal", awsErrorName: "Unknown", mayHaveActed: true }),
      // A refusal whose name says nothing was done, but the call may still have acted (a 5xx with that name).
      facts({ mayHaveActed: true }),
      // Not known (an error that is not an AwsError, a caller that did not say): taken as acted (R16).
      facts({ mayHaveActed: undefined }),
    ]) {
      expect(at(f), f.code).toEqual({
        to: "needs_attention",
        attempts: 1,
        lastError: lastErrorText(f),
      });
    }
  });

  it("a definite refusal that sent nothing, at the first run of the step, fails it: the charge goes back", () => {
    for (const f of [
      facts({}),
      facts({ code: "validation", awsErrorName: "UnsupportedTLD" }),
      facts({ code: "not_found", awsErrorName: "InvalidInput" }),
      // The adapter's own check before the call (no AWS error name).
      facts({ code: "validation", awsErrorName: null }),
    ]) {
      expect(at(f), lastErrorText(f)).toEqual({
        to: "failed",
        attempts: 1,
        lastError: lastErrorText(f),
      });
    }
  });

  it("after an earlier run at the step (a count or a last_error) the same refusal proves nothing: needs_attention", () => {
    // The earlier run's RenewDomain timed out (retryable, may have acted): attempts 1, last_error kept.
    expect(at(facts({}), 1, "upstream_unavailable:TimeoutError").to).toBe("needs_attention");
    expect(at(facts({}), 1, null).to).toBe("needs_attention");
    // A refusal of the engine keeps the count but records its code.
    expect(at(facts({}), 0, "invalid_step_result").to).toBe("needs_attention");
    // The caller did not say what the operation carried before this run.
    expect(
      decideFailure({
        kind: "renew_domain",
        step: "submit",
        attempts: 0,
        now: NOW,
        facts: facts({}),
      }).to,
    ).toBe("needs_attention");
    // The registry's own answer shape is not a proof at this step either.
    expect(at(facts({ awsErrorName: null, mayHaveActed: undefined })).to).toBe("needs_attention");
  });

  it("a retryable error at the step waits as before, whether or not it may have acted", () => {
    for (const mayHaveActed of [true, false]) {
      expect(at({ ...retryable, mayHaveActed })).toEqual({
        to: "waiting",
        attempts: 1,
        nextRunAt: after(60),
        lastError: "upstream_unavailable:ServiceException",
      });
    }
  });
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
