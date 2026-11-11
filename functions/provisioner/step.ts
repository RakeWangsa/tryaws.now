import type { OpCtx, ProductAdapter, ResourceView } from "@tc/aws";
import { LIGHTSAIL_REGIONS, type LightsailRegion } from "@tc/aws";
import {
  AWS_NAME_TYPES,
  OPERATION_KIND_INFO,
  awsResourceName,
  checkStepResult,
  isOperationKind,
  sendAfterCommit,
  transitionOperation,
  type AwsNameType,
  type QueueMessage,
  type StepResult,
} from "@tc/core";
import { loadOwnedResource, patchResource } from "@tc/db";
import type { OperationUpdate, ResourceRow, RunView } from "@tc/db";
import { claimStep } from "./claim";
import type { HookEvent, RunOutcome, StepDeps } from "./types";

// A private class: Task 13 turns it into the refusal invalid_step_result. Fixed messages only, so
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
  adapter: ProductAdapter<unknown>,
  leaseCheck: { operationId: string },
): OpCtx<unknown> {
  const { operation, resource, pool } = view;
  // claimStep refused an unplaced resource, so these are a bug if they are missing: fail closed (R16).
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
    config: adapter.parseConfig(resource.config),
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
  // Task 13 adds the branch of an engine kind (reject_operation) to runReject.
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

// One run of one step: claim, the adapter call outside any transaction, the record under the fence
// of the lease, and the message after the commit. An error of the adapter leaves it (Task 13).
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
  const adapter = view.resource === null ? undefined : deps.adapters.get(view.resource.family);
  if (view.resource === null || adapter === undefined) {
    throw new Error("step: the adapter is missing after the claim");
  }
  const resource = view.resource;

  const ctx = buildContext(deps, view, adapter, { operationId: view.operation.id });
  const raw = await callAdapter(adapter, view, ctx);
  const result = checkStepResult(raw, deps.clock.now());
  if (result === null) throw new StepResultError("step result: invalid");
  if (result.patch?.awsName !== undefined) checkAwsName(result.patch.awsName, resource.id);

  const event: HookEvent = {
    operationId: view.operation.id,
    resourceId: resource.id,
    customerId: resource.customerId,
    kind: view.operation.kind as HookEvent["kind"],
  };
  const recorded = await deps.runTx(async (tx) => {
    const now = deps.clock.now();
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
    kind: view.operation.kind,
    step: result.kind === "done" ? view.operation.step : result.step,
    outcome: "advanced",
    to,
    attempts: 0,
    sent,
  });
  return { outcome: "advanced", to, sent };
}
