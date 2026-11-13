import { AwsError, type ProductAdapter } from "@tc/aws";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { claim, transition, brief } = vi.hoisted(() => ({
  claim: vi.fn(),
  transition: vi.fn(),
  brief: vi.fn(),
}));
vi.mock("./claim", () => ({ claimStep: (...args: unknown[]) => claim(...args) }));
vi.mock("@tc/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/core")>()),
  transitionOperation: (...args: unknown[]) => transition(...args),
}));
vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  loadOperationBrief: (...args: unknown[]) => brief(...args),
}));

import { createManualClock, createMemoryQueue, stepDone, type LogEvent } from "@tc/core";
import type { RunView } from "@tc/db";
import { createAdapterRegistry } from "./adapters";
import { runReject } from "./reject";
import { runStep } from "./step";
import type { OperationHooks, StepDeps } from "./types";

// WPU-Z13 review round 1, without a database (the state changes and the target's row are fakes; the same paths
// through PostgreSQL are in domain-renewal.test.ts and reject.test.ts). The two ways a `renew_domain` reaches
// failed, which gives its charge back: the failure policy in runStep and an admin's rejection in runReject. Once
// RenewDomain was accepted (step `poll`) the registry holds the renewal and may still complete it, so neither
// refunds it without the registry's own refusal.

const NOW = new Date("2026-11-13T10:00:00.000Z");
const LEASE = new Date(NOW.getTime() + 120_000);
const TX = { tx: true } as never;
const OP = "0190a000-0000-7000-8000-000000000001";
const RESOURCE = "0190a000-0000-7000-8000-000000000002";
const CUSTOMER = "0190a000-0000-7000-8000-000000000003";
const REJECT = "0190a000-0000-7000-8000-000000000004";

function viewOf(operation: Record<string, unknown>): RunView {
  return {
    operation: {
      id: OP,
      resourceId: RESOURCE,
      kind: "renew_domain",
      state: "running",
      step: null,
      attempts: 0,
      lastError: null,
      payload: {},
      createdAt: NOW,
      ...operation,
    },
    resource: {
      id: RESOURCE,
      customerId: CUSTOMER,
      family: "domain",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "active",
      region: "us-east-1",
      config: {},
    },
    pool: null,
    owner: { orderCustomerId: null, keyCustomerId: null },
    blockedBy: null,
  } as unknown as RunView;
}

/** A domain adapter whose actions throw `error`. */
function throwing(error: AwsError) {
  const adapter: ProductAdapter<unknown> = {
    family: "domain",
    parseConfig: (input) => input,
    aws: {
      create: async () => stepDone(),
      suspend: async () => stepDone(),
      resume: async () => stepDone(),
      finalSnapshot: async () => stepDone(),
      destroy: async () => stepDone(),
      purgeSnapshots: async () => stepDone(),
      describe: async () => ({ state: "active" }),
      action: async () => {
        throw error;
      },
    },
  };
  return createAdapterRegistry([adapter]);
}

function setup(
  adapters = throwing(new AwsError({ code: "internal", retryable: true })),
  withHooks = true,
) {
  const failed = vi.fn<NonNullable<OperationHooks["failed"]>>(async () => undefined);
  const needsAttention = vi.fn<NonNullable<OperationHooks["needsAttention"]>>(
    async () => undefined,
  );
  const logged: LogEvent[] = [];
  const clock = createManualClock(NOW);
  const deps: StepDeps = {
    runTx: async (fn) => fn(TX),
    clock,
    queue: createMemoryQueue({ clock }),
    adapters,
    access: {} as never,
    env: "staging",
    ...(withHooks && { hooks: { failed, needsAttention } }),
    log: (e) => logged.push(e),
  };
  return { deps, failed, needsAttention, logged };
}

beforeEach(() => {
  claim.mockReset();
  transition.mockReset();
  brief.mockReset();
  transition.mockResolvedValue({ applied: true, enqueueSeq: 1 });
});

describe("runStep: the failure policy reads the step of the renewal", () => {
  const runWith = async (
    step: string | null,
    error: AwsError,
    previous: { attempts: number; lastError: string | null } = { attempts: 0, lastError: null },
  ) => {
    const s = setup(throwing(error));
    claim.mockResolvedValue({
      status: "run",
      view: viewOf({ step, ...previous }),
      leaseUntil: LEASE,
    });
    const outcome = await runStep(s.deps, { operationId: OP, resourceId: RESOURCE, enqueueSeq: 1 });
    return { ...s, outcome };
  };

  it("a poll that gave up after three days stops the renewal the registry holds in needs_attention: no refund", async () => {
    // packages/aws/adapters/domain.ts waitOrGiveUp: still in progress three days after the operation was created.
    const { outcome, failed, needsAttention } = await runWith(
      "poll",
      new AwsError({ code: "upstream_unavailable", retryable: false }),
    );
    expect(outcome).toEqual({ outcome: "advanced", to: "needs_attention", sent: false });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(TX, "worker", {
      id: OP,
      from: "running",
      fence: LEASE,
      to: "needs_attention",
      attempts: 1,
      lastError: "upstream_unavailable",
    });
    expect(failed).not.toHaveBeenCalled();
    expect(needsAttention).toHaveBeenCalledTimes(1);
  });

  it("the registry's failed answer at step poll fails it, and the failed hook gives the charge back once", async () => {
    const { outcome, failed } = await runWith(
      "poll",
      new AwsError({ code: "conflict", retryable: false }),
    );
    expect(outcome).toEqual({ outcome: "advanced", to: "failed", sent: false });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(TX, {
      operationId: OP,
      resourceId: RESOURCE,
      customerId: CUSTOMER,
      kind: "renew_domain",
      code: "conflict",
    });
  });

  it("a refusal before RenewDomain was accepted (step null) still fails it with its refund", async () => {
    const { outcome, failed } = await runWith(
      null,
      new AwsError({
        code: "conflict",
        retryable: false,
        awsErrorName: "TLDRulesViolation",
        operation: "RenewDomain",
      }),
    );
    expect(outcome).toEqual({ outcome: "advanced", to: "failed", sent: false });
    expect(failed).toHaveBeenCalledWith(TX, {
      operationId: OP,
      resourceId: RESOURCE,
      customerId: CUSTOMER,
      kind: "renew_domain",
      code: "conflict:TLDRulesViolation",
    });
  });
});

// Review round 2: RenewDomain is sent only at `submit`, which the adapter records before the call. runStep carries
// AwsError.mayHaveActed, the count and the last_error of the operation into decideFailure.
describe("runStep: a renewal at step submit (RenewDomain may have reached the registry)", () => {
  const runAt = async (
    error: AwsError,
    previous: { attempts: number; lastError: string | null } = { attempts: 0, lastError: null },
  ) => {
    const s = setup(throwing(error));
    claim.mockResolvedValue({
      status: "run",
      view: viewOf({ step: "submit", ...previous }),
      leaseUntil: LEASE,
    });
    const outcome = await runStep(s.deps, { operationId: OP, resourceId: RESOURCE, enqueueSeq: 1 });
    return { ...s, outcome };
  };
  const tldRefusal = new AwsError({
    code: "conflict",
    retryable: false,
    awsErrorName: "TLDRulesViolation",
    operation: "RenewDomain",
    mayHaveActed: false,
  });

  it("a final error of a RenewDomain that may have acted stops in needs_attention: no refund", async () => {
    const { outcome, failed, needsAttention } = await runAt(
      new AwsError({
        code: "internal",
        retryable: false,
        operation: "RenewDomain",
        mayHaveActed: true,
      }),
    );
    expect(outcome).toEqual({ outcome: "advanced", to: "needs_attention", sent: false });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(TX, "worker", {
      id: OP,
      from: "running",
      fence: LEASE,
      to: "needs_attention",
      attempts: 1,
      lastError: "internal",
    });
    expect(failed).not.toHaveBeenCalled();
    expect(needsAttention).toHaveBeenCalledTimes(1);
  });

  it("a time-out after the request was sent waits at submit and moves no money", async () => {
    const { outcome, failed } = await runAt(
      new AwsError({
        code: "upstream_unavailable",
        retryable: true,
        awsErrorName: "TimeoutError",
        operation: "RenewDomain",
        mayHaveActed: true,
      }),
    );
    expect(outcome).toEqual({ outcome: "advanced", to: "waiting", sent: false });
    expect(transition).toHaveBeenCalledWith(
      TX,
      "worker",
      expect.objectContaining({
        to: "waiting",
        attempts: 1,
        lastError: "upstream_unavailable:TimeoutError",
      }),
    );
    expect(failed).not.toHaveBeenCalled();
  });

  it("a definite refusal of RenewDomain at the first run of the step fails it, and the hook gives the charge back once", async () => {
    const { outcome, failed } = await runAt(tldRefusal);
    expect(outcome).toEqual({ outcome: "advanced", to: "failed", sent: false });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(TX, {
      operationId: OP,
      resourceId: RESOURCE,
      customerId: CUSTOMER,
      kind: "renew_domain",
      code: "conflict:TLDRulesViolation",
    });
  });

  it("the same refusal after an earlier run at the step whose RenewDomain timed out: needs_attention, no refund", async () => {
    const { outcome, failed } = await runAt(tldRefusal, {
      attempts: 1,
      lastError: "upstream_unavailable:TimeoutError",
    });
    expect(outcome).toEqual({ outcome: "advanced", to: "needs_attention", sent: false });
    expect(failed).not.toHaveBeenCalled();
  });

  it("an error that is not an AwsError counts as acted: it waits, then needs attention, never refunds", async () => {
    const { outcome, failed } = await runAt(new Error("boom") as unknown as AwsError, {
      attempts: 4,
      lastError: "internal",
    });
    expect(outcome).toEqual({ outcome: "advanced", to: "needs_attention", sent: false });
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("runReject: an admin's rejection of a stuck renewal", () => {
  const rejectView = viewOf({
    id: REJECT,
    kind: "reject_operation",
    payload: { targetOperationId: OP },
  });
  const target = (over: Record<string, unknown>) => ({
    id: OP,
    resourceId: RESOURCE,
    kind: "renew_domain",
    state: "needs_attention",
    step: null,
    ...over,
  });

  it("a renewal the registry holds (step poll) is not rejected: renewal_submitted, the target stays, no refund", async () => {
    const { deps, failed, needsAttention, logged } = setup();
    brief.mockResolvedValue(target({ step: "poll" }));
    expect(await runReject(deps, rejectView, LEASE)).toEqual({
      outcome: "advanced",
      to: "needs_attention",
      sent: false,
    });
    // Only the reject operation moves; the target is not touched.
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(TX, "worker", {
      id: REJECT,
      from: "running",
      fence: LEASE,
      to: "needs_attention",
      attempts: 0,
      lastError: "renewal_submitted",
    });
    expect(failed).not.toHaveBeenCalled();
    expect(needsAttention).toHaveBeenCalledWith(TX, {
      operationId: REJECT,
      resourceId: RESOURCE,
      kind: "reject_operation",
      code: "renewal_submitted",
    });
    expect(logged).toEqual([expect.objectContaining({ code: "renewal_submitted" })]);
  });

  it("a renewal at step submit (RenewDomain may have been sent) is not rejected either: renewal_submitted, no refund", async () => {
    const { deps, failed } = setup();
    brief.mockResolvedValue(target({ step: "submit" }));
    expect(await runReject(deps, rejectView, LEASE)).toEqual({
      outcome: "advanced",
      to: "needs_attention",
      sent: false,
    });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(
      TX,
      "worker",
      expect.objectContaining({
        id: REJECT,
        to: "needs_attention",
        lastError: "renewal_submitted",
      }),
    );
    expect(failed).not.toHaveBeenCalled();
  });

  it("the admin is told the same without a failed hook: the registry holds the renewal", async () => {
    const { deps } = setup(undefined, false);
    brief.mockResolvedValue(target({ step: "poll" }));
    expect(await runReject(deps, rejectView, LEASE)).toMatchObject({ to: "needs_attention" });
    expect(transition).toHaveBeenCalledWith(
      TX,
      "worker",
      expect.objectContaining({ id: REJECT, lastError: "renewal_submitted" }),
    );
  });

  it("a renewal the registry does not hold yet (step null) is rejected, and its charge goes back through the failed hook", async () => {
    const { deps, failed } = setup();
    brief.mockResolvedValue(target({ step: null }));
    expect(await runReject(deps, rejectView, LEASE)).toMatchObject({ to: "succeeded" });
    expect(transition).toHaveBeenCalledWith(
      TX,
      "worker",
      expect.objectContaining({ id: OP, from: "needs_attention", to: "failed" }),
    );
    expect(failed).toHaveBeenCalledWith(TX, {
      operationId: OP,
      resourceId: RESOURCE,
      customerId: CUSTOMER,
      kind: "renew_domain",
      code: "rejected",
    });
  });

  it("a create at step poll is still rejected with its refund: only a domain renewal waits for the registry", async () => {
    const { deps, failed } = setup();
    brief.mockResolvedValue(target({ kind: "create", step: "poll" }));
    expect(await runReject(deps, rejectView, LEASE)).toMatchObject({ to: "succeeded" });
    expect(failed).toHaveBeenCalledWith(TX, expect.objectContaining({ kind: "create" }));
  });
});
