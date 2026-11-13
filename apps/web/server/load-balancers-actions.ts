import { MAX_LB_TARGETS, checkLbTargets, parseLoadBalancerConfig } from "@tc/core";
import type { CheckedTargets, TargetCandidate } from "@tc/core";
import { destroyFamilyCore } from "./family-actions.ts";
import {
  FAMILY_WRITE_LIMIT,
  Refusal,
  UUID,
  audit,
  frame,
  ownResource,
  parseOf,
  record,
  uuidField,
} from "./family-actions.ts";
import type { FamilyActionDeps, FamilyRepos, FamilyResult, FamilySpec } from "./family-actions.ts";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";

// The cores of the Server Actions of the load balancer screens (/load-balancers, 16.10):
// `createOrderDraft` (review), `setTargets` and `destroyLoadBalancer`. R9 order in each (see
// family-actions.ts). Every action is an operation row or a draft (R1: nothing here calls AWS).
//
// The targets are the customer's own servers in the Region of the balancer (R8). The order code checks
// that for a new balancer; `setTargets` checks it again here, with a read of every id through the
// customer-scoped repository and the same pure rule (checkLbTargets), because the adapter would
// check it later, but a refusal on the spot is what the customer sees.
//
// The HTTPS certificate, the health check path and the redirect are in console-actions.ts (WPU-G7).
// The per-target health is a read of the reader (WPU-Y8, server/reader-reads-view.ts), not an action.

export const LOAD_BALANCER_SPEC: FamilySpec = {
  family: "load_balancer",
  idField: "loadBalancerId",
  prefix: "lb",
  withFinalSnapshot: false,
};

function text(input: Record<string, unknown>, key: string): unknown {
  const value = input[key];
  return typeof value === "string" ? value.trim() : value;
}

/** The list of target ids of a form: an array of strings, or the value is not a list at all. */
function idsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

/** /load-balancers/new: the form's four fields, nothing else, become the config of a balancer (R11). */
export async function createLoadBalancerDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = record(raw);
  const ids = idsOf(input["targetIds"]);
  const parsed = parseLoadBalancerConfig({
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
    targetIds: ids ?? "invalid",
  });
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }
  // A balancer without a target is of no use; say it in the form before the order code does.
  if (parsed.value.targetIds.length === 0) {
    return { ok: false, error: "validation", fields: { targetIds: "invalid" } };
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  // The ownership of the targets is checked inside the order code, through the scoped repository (R8).
  const result = await deps.orders.createOrderDraft(session, {
    family: "load_balancer",
    config: { ...parsed.value },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error, result.data),
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

/**
 * The change of the targets as an operation. `null` until the backend has a kind for it: the adapter
 * has no action for a load balancer yet (JOURNEY.md, Needs decision), so the core refuses (R16).
 */
export type ChangeTargetsPort = (
  repos: FamilyRepos,
  input: { loadBalancerId: string; targets: CheckedTargets; requestId: string },
) => Promise<"queued" | "conflict" | "not_found">;

/**
 * The real port (WPU-G7): one `set_targets` operation with the checked ids as its payload. A repeat of
 * the same request id is the same operation (R7); a sibling that is still running is a conflict.
 */
export const queueTargets: ChangeTargetsPort = async (repos, input) => {
  const written = await repos.operations.request({
    resourceId: input.loadBalancerId,
    kind: "set_targets",
    idempotencyKey: `lb-targets:${input.requestId}`,
    payload: { targetIds: [...input.targets] },
  });
  if (written.ok) return "queued";
  return written.error === "not_found" ? "not_found" : "conflict";
};

export interface LoadBalancerTargetsDeps extends FamilyActionDeps {
  changeTargets: ChangeTargetsPort | null;
}

/** 16.10 `setTargets`: attach and detach in one step, to the list the customer chose. */
export async function setLoadBalancerTargetsCore(
  deps: LoadBalancerTargetsDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const loadBalancerId = uuidField(input, "loadBalancerId", bad);
  const requestId = uuidField(input, "requestId", bad);
  const requested = idsOf(input["targetIds"]);
  if (
    requested === null ||
    requested.length === 0 ||
    requested.length > MAX_LB_TARGETS ||
    !requested.every((id) => UUID.test(id))
  ) {
    bad["targetIds"] = "invalid";
  }
  return frame(
    deps,
    {
      destructive: false,
      limits: FAMILY_WRITE_LIMIT(LOAD_BALANCER_SPEC.prefix),
      own: { family: "load_balancer", id: loadBalancerId },
    },
    parseOf(bad),
    async (repos, session, owned) => {
      const balancer = owned ?? (await ownResource(repos, "load_balancer", loadBalancerId));
      if (balancer.state !== "active" || balancer.region === null) throw new Refusal("not_allowed");
      const ids = requested as string[];
      // Every id is read through the scoped repository: another customer's server is a missing one.
      const candidates: (TargetCandidate | null)[] = [];
      for (const id of ids) {
        const row = await repos.resources.get(id);
        const cfgRegion = (row?.config as { region?: unknown } | null | undefined)?.region;
        candidates.push(
          row === null
            ? null
            : {
                id: row.id,
                customerId: session.customerId,
                family: row.family,
                state: row.state,
                region: row.region ?? (typeof cfgRegion === "string" ? cfgRegion : ""),
              },
        );
      }
      const checked = checkLbTargets({
        customerId: session.customerId,
        region: balancer.region,
        requested: ids,
        candidates,
      });
      if (!checked.ok) throw new Refusal("validation", { targetIds: "invalid" });
      if (deps.changeTargets === null) throw new Refusal("unavailable");
      const queued = await deps.changeTargets(repos, {
        loadBalancerId: balancer.id,
        targets: checked.value,
        requestId,
      });
      if (queued !== "queued")
        throw new Refusal(queued === "not_found" ? "not_found" : "not_allowed");
      await audit(repos, `${LOAD_BALANCER_SPEC.prefix}.set_targets`, balancer.id);
      return { ok: true, done: "targetsQueued" };
    },
  );
}

/** 16.10 `destroyLoadBalancer` (U10, R13): no snapshot, the settings are kept; approval until 2026-12-01. */
export const destroyLoadBalancerCore = (
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> => destroyFamilyCore(deps, LOAD_BALANCER_SPEC, raw);
