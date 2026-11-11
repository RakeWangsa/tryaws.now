import type { OpCtx, ProductAdapter, ResourceView } from "@tc/aws";
import { AwsError, LIGHTSAIL_REGIONS, type LightsailRegion } from "@tc/aws";
import {
  AWS_NAME_TYPES,
  OPERATION_KIND_INFO,
  awsResourceName,
  checkStepResult,
  decideFailure,
  decideRefusal,
  isOperationKind,
  sendAfterCommit,
  transitionOperation,
  type AwsNameType,
  type FailureDecision,
  type FailureFacts,
  type LocalFailure,
  type QueueMessage,
  type StepResult,
} from "@tc/core";
import { loadOwnedResource, patchResource } from "@tc/db";
import type { OperationUpdate, ResourceRow, RunView } from "@tc/db";
import { claimStep } from "./claim";
import { runReject } from "./reject";
import type { HookEvent, RunOutcome, StepDeps } from "./types";

// A private class: runStep turns it into the refusal invalid_step_result. Fixed messages only, so
// nothing an adapter returned reaches a log (R14).
class StepResultError extends Error {
  override readonly name = "StepResultError";
}

function toResourceView(row: ResourceRow): ResourceView {
  return {
    id: row.id,
    customerId: row.customerId,
    family: row.family,
    productId: row.productId,
    parentResourceId: row.parentResourceId,
    awsName: row.awsName,
    state: row.state,
    config: row.config,
  };
}

function isLightsailRegion(value: unknown): value is LightsailRegion {
  return (LIGHTSAIL_REGIONS as readonly unknown[]).includes(value);
}

// R11: the name is made from this resource's id, an adapter cannot give a resource another one.
function checkAwsName(name: string, resourceId: string): void {
  const type = name.slice(3, name.lastIndexOf("-"));
  const known = AWS_NAME_TYPES.find((candidate): candidate is AwsNameType => candidate === type);
  if (known === undefined || awsResourceName(known, resourceId) !== name) {
    throw new StepResultError("step result: the aws name is not the name of this resource");
  }
}

function buildContext(
  deps: StepDeps,
  view: RunView,
  config: unknown,
  leaseCheck: { operationId: string },
): OpCtx<unknown> {
  const { operation, resource, pool } = view;
  // runStep checked the placement before, so these are a bug if they are missing: fail closed (R16).
  if (resource === null || pool === null || !isLightsailRegion(resource.region)) {
    throw new Error("step: the resource is not placed");
  }
  const customerId = resource.customerId;
  return Object.freeze({
    operation: Object.freeze({
      id: leaseCheck.operationId,
      kind: operation.kind as OpCtx<unknown>["operation"]["kind"],
      step: operation.step,
      attempt: operation.attempts + 1,
      createdAt: operation.createdAt,
      payload: operation.payload,
    }),
    stepKey: `${operation.id}:${operation.step ?? "start"}`,
    resource: Object.freeze(toResourceView(resource)),
    config,
    account: Object.freeze({ awsAccountId: pool.awsAccountId, externalId: pool.externalId }),
    region: resource.region,
    access: deps.access,
    env: deps.env,
    clock: deps.clock,
    owned: async (id: string) => {
      const row = await deps.runTx((tx) => loadOwnedResource(tx, customerId, id));
      return row === null ? null : toResourceView(row);
    },
  });
}

async function callAdapter(
  adapter: ProductAdapter<unknown>,
  view: RunView,
  ctx: OpCtx<unknown>,
): Promise<unknown> {
  const kind = view.operation.kind;
  if (!isOperationKind(kind)) throw new Error("step: unknown operation kind");
  const method = OPERATION_KIND_INFO[kind].method;
  // runStep sends an engine kind (reject_operation) to runReject before it gets here.
  if (method === "engine") throw new Error("step: an engine kind has no adapter method");
  if (method === "action") return adapter.aws.action(kind, ctx);
  return adapter.aws[method](ctx);
}

type Advanced = Extract<RunOutcome, { outcome: "advanced" }>;

function updateFor(
  view: RunView,
  result: StepResult,
  leaseUntil: Date,
  now: Date,
): OperationUpdate {
  const base = { id: view.operation.id, from: "running" as const, fence: leaseUntil };
  switch (result.kind) {
    case "next":
      return {
        ...base,
        to: "queued",
        step: result.step,
        attempts: 0,
        lastError: null,
        nextRunAt: now,
        bumpEnqueueSeq: true,
      };
    case "wait":
      return {
        ...base,
        to: "waiting",
        step: result.step,
        attempts: 0,
        lastError: null,
        nextRunAt: result.until,
      };
    case "done":
      return { ...base, to: "succeeded", attempts: 0, lastError: null };
  }
}

// What a run records. A refusal of the engine is a FailureDecision too (needs_attention, no attempt counted).
type Plan =
  | { readonly kind: "step"; readonly result: StepResult }
  | { readonly kind: "failure"; readonly decision: FailureDecision };

const refusal = (code: Exclude<LocalFailure, "lease_expired">, attempts: number): Plan => ({
  kind: "failure",
  decision: decideRefusal(code, attempts),
});

// R14: only the code of an AwsError is kept; the text of any other error is dropped.
function factsOf(error: unknown): FailureFacts {
  if (error instanceof AwsError) {
    return {
      code: error.code,
      retryable: error.retryable,
      poolFull: error.poolFull,
      awsErrorName: error.awsErrorName,
    };
  }
  return { code: "internal", retryable: true, poolFull: false, awsErrorName: null };
}

// The adapter call and the checks of what it returned. Every way for the step to fail is a Plan.
async function plan(
  deps: StepDeps,
  view: RunView,
  adapter: ProductAdapter<unknown>,
  resource: ResourceRow,
): Promise<Plan> {
  const { operation } = view;
  if (view.pool === null || !isLightsailRegion(resource.region)) {
    return refusal("resource_unplaced", operation.attempts);
  }
  let config: unknown;
  try {
    config = adapter.parseConfig(resource.config);
  } catch {
    return refusal("invalid_config", operation.attempts);
  }
  const ctx = buildContext(deps, view, config, { operationId: operation.id });

  let raw: unknown;
  try {
    raw = await callAdapter(adapter, view, ctx);
  } catch (error) {
    const decision = decideFailure({
      kind: operation.kind as HookEvent["kind"],
      attempts: operation.attempts,
      now: deps.clock.now(),
      facts: factsOf(error),
    });
    // R16: a create reaches failed only when the hook that reverses the money is installed.
    if (decision.to === "failed" && deps.hooks?.failed === undefined) {
      return refusal("failed_hook_missing", decision.attempts);
    }
    return { kind: "failure", decision };
  }

  const result = checkStepResult(raw, deps.clock.now());
  if (result === null) return refusal("invalid_step_result", operation.attempts);
  try {
    if (result.patch?.awsName !== undefined) checkAwsName(result.patch.awsName, resource.id);
  } catch (error) {
    if (error instanceof StepResultError) {
      return refusal("invalid_step_result", operation.attempts);
    }
    throw error;
  }
  return { kind: "step", result };
}

// One run of one step: claim, the adapter call outside any transaction, the record under the fence
// of the lease, and the message after the commit. A failure of the step is recorded, not thrown; a
// throwing hook rolls the record back and leaves the run to the sweeper (an expired lease).
export async function runStep(deps: StepDeps, message: QueueMessage): Promise<RunOutcome> {
  const claim = await claimStep(
    {
      runTx: deps.runTx,
      clock: deps.clock,
      hasAdapter: (family) => deps.adapters.get(family) !== undefined,
      ...(deps.destructiveGuard !== undefined && { destructiveGuard: deps.destructiveGuard }),
      ...(deps.hooks?.needsAttention !== undefined && { onAttention: deps.hooks.needsAttention }),
    },
    message,
  );
  if (claim.status === "skipped") {
    deps.log({
      event: "operation_step",
      operationId: message.operationId,
      outcome: "skipped",
      reason: claim.reason,
    });
    return { outcome: "skipped", reason: claim.reason };
  }
  if (claim.status === "refused") {
    deps.log({
      event: "operation_step",
      operationId: message.operationId,
      outcome: "refused",
      code: claim.code,
    });
    return { outcome: "refused", code: claim.code };
  }

  const { view, leaseUntil } = claim;
  const kind = view.operation.kind;
  if (!isOperationKind(kind)) throw new Error("step: unknown operation kind");
  if (OPERATION_KIND_INFO[kind].method === "engine") return runReject(deps, view, leaseUntil);

  const adapter = view.resource === null ? undefined : deps.adapters.get(view.resource.family);
  if (view.resource === null || adapter === undefined) {
    throw new Error("step: the adapter is missing after the claim");
  }
  const resource = view.resource;
  const chosen = await plan(deps, view, adapter, resource);

  const event: HookEvent = {
    operationId: view.operation.id,
    resourceId: resource.id,
    customerId: resource.customerId,
    kind,
  };
  const recorded = await deps.runTx(async (tx): Promise<number | null> => {
    const now = deps.clock.now();
    if (chosen.kind === "failure") {
      const { decision } = chosen;
      const applied = await transitionOperation(tx, "worker", {
        id: view.operation.id,
        from: "running",
        fence: leaseUntil,
        to: decision.to,
        attempts: decision.attempts,
        lastError: decision.lastError,
        ...(decision.to === "waiting" && { nextRunAt: decision.nextRunAt }),
      });
      if (!applied.applied) return null;
      if (decision.to === "failed") {
        await deps.hooks?.failed?.(tx, { ...event, code: decision.lastError });
      }
      if (decision.to !== "waiting") {
        await deps.hooks?.needsAttention?.(tx, {
          operationId: event.operationId,
          resourceId: event.resourceId,
          kind: event.kind,
          code: decision.lastError,
        });
      }
      return applied.enqueueSeq;
    }
    const { result } = chosen;
    const applied = await transitionOperation(
      tx,
      "worker",
      updateFor(view, result, leaseUntil, now),
    );
    if (!applied.applied) return null;
    if (result.patch !== undefined) {
      const { state, awsName, configMerge } = result.patch;
      await patchResource(tx, resource.id, {
        ...(state !== undefined && { state }),
        ...(awsName !== undefined && { awsName }),
        ...(configMerge !== undefined && { configMerge }),
        ...(state === "destroyed" && { deletedAt: now }),
      });
    }
    if (result.kind === "done") await deps.hooks?.succeeded?.(tx, event);
    return applied.enqueueSeq;
  });

  if (recorded === null) {
    deps.log({ event: "operation_step", operationId: view.operation.id, outcome: "stale" });
    return { outcome: "stale" };
  }

  if (chosen.kind === "failure") {
    const { decision } = chosen;
    deps.log({
      event: "operation_step",
      operationId: view.operation.id,
      resourceId: resource.id,
      kind,
      step: view.operation.step,
      outcome: "advanced",
      to: decision.to,
      code: decision.lastError,
      attempts: decision.attempts,
      sent: false,
    });
    return { outcome: "advanced", to: decision.to, sent: false };
  }

  const { result } = chosen;
  const to: Advanced["to"] =
    result.kind === "next" ? "queued" : result.kind === "wait" ? "waiting" : "succeeded";
  const sent =
    result.kind === "next"
      ? await sendAfterCommit(deps.queue, {
          operationId: view.operation.id,
          resourceId: resource.id,
          enqueueSeq: recorded,
        })
      : false;

  deps.log({
    event: "operation_step",
    operationId: view.operation.id,
    resourceId: resource.id,
    kind,
    step: result.kind === "done" ? view.operation.step : result.step,
    outcome: "advanced",
    to,
    attempts: 0,
    sent,
  });
  return { outcome: "advanced", to, sent };
}
