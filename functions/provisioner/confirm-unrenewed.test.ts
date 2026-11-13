import { AwsError } from "@tc/aws";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { claim, transition, brief, payloadOf } = vi.hoisted(() => ({
  claim: vi.fn(),
  transition: vi.fn(),
  brief: vi.fn(),
  payloadOf: vi.fn(),
}));
vi.mock("./claim", () => ({ claimStep: (...args: unknown[]) => claim(...args) }));
vi.mock("@tc/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/core")>()),
  transitionOperation: (...args: unknown[]) => transition(...args),
}));
vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  loadOperationBrief: (...args: unknown[]) => brief(...args),
  loadOperationPayload: (...args: unknown[]) => payloadOf(...args),
}));

import { createManualClock, createMemoryQueue, type LogEvent, type RenewalRecheck } from "@tc/core";
import type { RunView } from "@tc/db";
import { createAdapterRegistry } from "./adapters";
import { runConfirmUnrenewed } from "./confirm-unrenewed";
import { runStep } from "./step";
import type { OperationHooks, RenewalRecheckFn, StepDeps } from "./types";

// WPU-X3 (b), without a database (the state changes and the target's row are fakes). The admin's "registry confirmed
// not renewed" of a renewal stuck in needs_attention at poll: a fresh registry check outside any transaction, then
// one transaction that refunds only on a final "not renewed" with the expiry unchanged, and only when the target did
// not move during the check. Anything else records why on the confirm operation and leaves the target and the money.

const NOW = new Date("2026-11-14T10:00:00.000Z");
const LEASE = new Date(NOW.getTime() + 120_000);
const TX = { tx: true } as never;
const TARGET = "0190a000-0000-7000-8000-000000000001";
const RESOURCE = "0190a000-0000-7000-8000-000000000002";
const CUSTOMER = "0190a000-0000-7000-8000-000000000003";
const CONFIRM = "0190a000-0000-7000-8000-000000000004";
const OTHER_RESOURCE = "0190a000-0000-7000-8000-000000000005";
const PAYLOAD = { currentExpiryYear: 2027, currentExpiresAt: "2027-01-02T03:04:05.678Z" };

function view(over: { family?: string; payload?: unknown } = {}): RunView {
  return {
    operation: {
      id: CONFIRM,
      resourceId: RESOURCE,
      kind: "confirm_unrenewed",
      state: "running",
      step: null,
      attempts: 0,
      lastError: null,
      payload: over.payload ?? { targetOperationId: TARGET, requestId: CONFIRM },
      createdAt: NOW,
    },
    resource: {
      id: RESOURCE,
      customerId: CUSTOMER,
      family: over.family ?? "domain",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "active",
      region: "us-east-1",
      config: { name: "example.com", renewOperationId: "op-renew-1" },
    },
    pool: null,
    owner: { orderCustomerId: null, keyCustomerId: null },
    blockedBy: null,
  } as unknown as RunView;
}

const target = (over: Record<string, unknown> = {}) => ({
  id: TARGET,
  resourceId: RESOURCE,
  kind: "renew_domain",
  state: "needs_attention",
  step: "poll",
  attempts: 2,
  lastError: "upstream_unavailable",
  ...over,
});

function setup(
  recheck: RenewalRecheckFn | null = async () => ({ verdict: "unrenewed" }),
  withHooks = true,
) {
  const failed = vi.fn<NonNullable<OperationHooks["failed"]>>(async () => undefined);
  const needsAttention = vi.fn<NonNullable<OperationHooks["needsAttention"]>>(
    async () => undefined,
  );
  const checks = vi.fn<RenewalRecheckFn>(
    recheck ?? (async () => ({ verdict: "unrenewed" }) as RenewalRecheck),
  );
  const logged: LogEvent[] = [];
  const clock = createManualClock(NOW);
  const deps: StepDeps = {
    runTx: async (fn) => fn(TX),
    clock,
    queue: createMemoryQueue({ clock }),
    adapters: createAdapterRegistry([]),
    access: {} as never,
    env: "staging",
    ...(withHooks && { hooks: { failed, needsAttention } }),
    ...(recheck !== null && { renewalRecheck: checks }),
    log: (e) => logged.push(e),
  };
  return { deps, failed, needsAttention, checks, logged };
}

const keptWith = (code: string) => ({
  id: CONFIRM,
  from: "running",
  fence: LEASE,
  to: "needs_attention",
  attempts: 0,
  lastError: code,
});

beforeEach(() => {
  claim.mockReset();
  transition.mockReset();
  brief.mockReset();
  payloadOf.mockReset();
  payloadOf.mockResolvedValue({ payload: PAYLOAD });
  transition.mockResolvedValue({ applied: true, enqueueSeq: 1 });
});

describe("runConfirmUnrenewed", () => {
  it("a confirmed 'not renewed' moves the renewal to failed and runs the failed hook (the refund) in one transaction", async () => {
    const { deps, failed, needsAttention, checks, logged } = setup();
    brief.mockResolvedValue(target());
    expect(await runConfirmUnrenewed(deps, view(), LEASE)).toEqual({
      outcome: "advanced",
      to: "succeeded",
      sent: false,
    });
    // The check reads the name and the saved RenewDomain operation id of the resource, and the target's payload
    // (read apart from the brief, for this resource only).
    expect(payloadOf).toHaveBeenCalledWith(TX, TARGET, RESOURCE);
    expect(checks).toHaveBeenCalledWith({
      name: "example.com",
      renewOperationId: "op-renew-1",
      payload: PAYLOAD,
    });
    expect(transition).toHaveBeenNthCalledWith(1, TX, "worker", {
      id: CONFIRM,
      from: "running",
      fence: LEASE,
      to: "succeeded",
      attempts: 0,
      lastError: null,
    });
    expect(transition).toHaveBeenNthCalledWith(2, TX, "worker", {
      id: TARGET,
      from: "needs_attention",
      to: "failed",
      lastError: "renewal_unrenewed_confirmed",
    });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(TX, {
      operationId: TARGET,
      resourceId: RESOURCE,
      customerId: CUSTOMER,
      kind: "renew_domain",
      code: "renewal_unrenewed_confirmed",
    });
    expect(needsAttention).toHaveBeenCalledWith(TX, {
      operationId: TARGET,
      resourceId: RESOURCE,
      kind: "renew_domain",
      code: "renewal_unrenewed_confirmed",
    });
    // R14: ids and fixed words only.
    expect(JSON.stringify(logged)).not.toContain("example.com");
    expect(logged).toEqual([
      expect.objectContaining({ operationId: CONFIRM, outcome: "advanced", to: "succeeded" }),
    ]);
  });

  it.each([
    "registry_renewed",
    "renewal_in_progress",
    "expiry_changed",
    "renewal_unreadable",
  ] as const)(
    "a check that keeps the renewal (%s) records why on the confirm operation; the target and the money stay",
    async (reason) => {
      const { deps, failed, needsAttention } = setup(async () => ({ verdict: "kept", reason }));
      brief.mockResolvedValue(target());
      expect(await runConfirmUnrenewed(deps, view(), LEASE)).toEqual({
        outcome: "advanced",
        to: "needs_attention",
        sent: false,
      });
      expect(transition).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith(reason));
      expect(failed).not.toHaveBeenCalled();
      expect(needsAttention).toHaveBeenCalledWith(TX, {
        operationId: CONFIRM,
        resourceId: RESOURCE,
        kind: "confirm_unrenewed",
        code: reason,
      });
    },
  );

  it("an AWS error (or any error) of the check is registry_unreachable, never a refund", async () => {
    for (const error of [
      new AwsError({ code: "upstream_unavailable", retryable: true }),
      new Error("boom"),
    ]) {
      transition.mockClear();
      const { deps, failed } = setup(async () => {
        throw error;
      });
      brief.mockResolvedValue(target());
      expect(await runConfirmUnrenewed(deps, view(), LEASE)).toMatchObject({
        to: "needs_attention",
      });
      expect(transition).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith("registry_unreachable"));
      expect(failed).not.toHaveBeenCalled();
    }
  });

  it("a target that moved during the check (a retry, another failure) is left: target_changed, no refund", async () => {
    for (const moved of [
      { attempts: 3 },
      { lastError: "conflict" },
      { state: "queued" },
      { step: "submit" },
    ]) {
      transition.mockClear();
      brief.mockReset();
      const { deps, failed } = setup();
      brief.mockResolvedValueOnce(target()).mockResolvedValueOnce(target(moved));
      expect(await runConfirmUnrenewed(deps, view(), LEASE)).toMatchObject({
        to: "needs_attention",
      });
      expect(transition).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith("target_changed"));
      expect(failed).not.toHaveBeenCalled();
    }
  });

  it("a target that is not a renewal stuck at poll is refused before any registry call", async () => {
    for (const t of [
      target({ step: "submit" }),
      target({ step: null }),
      target({ state: "failed" }),
      target({ state: "waiting" }),
      target({ kind: "create" }),
    ]) {
      transition.mockClear();
      const { deps, checks, failed } = setup();
      brief.mockResolvedValue(t);
      expect(await runConfirmUnrenewed(deps, view(), LEASE)).toMatchObject({
        to: "needs_attention",
      });
      expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith("renewal_not_confirmable"));
      expect(checks).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
    }
  });

  it("cross-tenant: a target of another resource is owner_mismatch, and a resource that is no domain is refused", async () => {
    const a = setup();
    brief.mockResolvedValue(target({ resourceId: OTHER_RESOURCE }));
    expect(await runConfirmUnrenewed(a.deps, view(), LEASE)).toMatchObject({
      to: "needs_attention",
    });
    expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith("owner_mismatch"));
    expect(a.checks).not.toHaveBeenCalled();

    transition.mockClear();
    const b = setup();
    brief.mockResolvedValue(target());
    expect(await runConfirmUnrenewed(b.deps, view({ family: "dns_zone" }), LEASE)).toMatchObject({
      to: "needs_attention",
    });
    expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith("renewal_not_confirmable"));
    expect(b.checks).not.toHaveBeenCalled();
  });

  it("a payload without a target, a missing target, no failed hook or no registry check: refused, nothing asked (R16)", async () => {
    const cases: [ReturnType<typeof setup>, RunView, unknown, string][] = [
      [setup(), view({ payload: {} }), target(), "invalid_step_result"],
      [setup(), view(), null, "owner_mismatch"],
      [setup(undefined, false), view(), target(), "failed_hook_missing"],
      [setup(null), view(), target(), "renewal_check_missing"],
    ];
    // setup(null) installs no renewalRecheck.
    for (const [s, v, t, code] of cases) {
      transition.mockClear();
      brief.mockReset();
      brief.mockResolvedValue(t);
      expect(await runConfirmUnrenewed(s.deps, v, LEASE)).toMatchObject({
        to: "needs_attention",
      });
      expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith(code));
      expect(s.failed).not.toHaveBeenCalled();
    }
  });

  it("a payload that cannot be read for this resource is owner_mismatch, nothing asked", async () => {
    const { deps, checks, failed } = setup();
    brief.mockResolvedValue(target());
    payloadOf.mockResolvedValue(null);
    expect(await runConfirmUnrenewed(deps, view(), LEASE)).toMatchObject({
      to: "needs_attention",
    });
    expect(transition).toHaveBeenCalledWith(TX, "worker", keptWith("owner_mismatch"));
    expect(checks).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("a stale lease writes nothing more: the target is never moved", async () => {
    const { deps, failed } = setup();
    brief.mockResolvedValue(target());
    transition.mockResolvedValue({ applied: false });
    expect(await runConfirmUnrenewed(deps, view(), LEASE)).toEqual({ outcome: "stale" });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("runStep sends a confirm_unrenewed to this runner (an engine kind), not to reject", async () => {
    const { deps, failed } = setup();
    claim.mockResolvedValue({ status: "run", view: view(), leaseUntil: LEASE });
    brief.mockResolvedValue(target());
    expect(
      await runStep(deps, { operationId: CONFIRM, resourceId: RESOURCE, enqueueSeq: 1 }),
    ).toEqual({ outcome: "advanced", to: "succeeded", sent: false });
    expect(failed).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ code: "renewal_unrenewed_confirmed" }),
    );
  });
});
