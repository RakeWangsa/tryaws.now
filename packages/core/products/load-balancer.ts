import type { CatalogProduct } from "@tc/db";
import type { CapacityNeed } from "../capacity/types";
import type { ProductFacts } from "../orders/gates";
import type { Result } from "../types";

export const MAX_LB_TARGETS = 20;
const INSTANCE_FAMILIES: readonly string[] = ["linux_instance", "windows_instance"];

export interface LoadBalancerConfig {
  readonly productId: string;
  readonly region: string;
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string;
  /** Resource ids of the customer's own instances. Checked by checkLbTargets before use. */
  readonly targetIds: readonly string[];
}

export interface ResolvedLoadBalancer {
  readonly family: "load_balancer";
  readonly productId: string;
  readonly region: string;
  readonly featureFlag: string;
  readonly awsPriceUsd: string;
  readonly facts: ProductFacts;
  readonly needs: readonly CapacityNeed[];
  readonly resourceConfig: Readonly<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hand-written; unknown keys and `awsName` are dropped, never copied. */
export function parseLoadBalancerConfig(raw: unknown): Result<LoadBalancerConfig> {
  const input = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const { productId, region, displayName, targetIds } = input;
  if (typeof productId !== "string" || !UUID.test(productId)) fields.productId = "invalid";
  if (typeof region !== "string" || !REGION.test(region)) fields.region = "invalid";
  if (typeof displayName !== "string" || !DISPLAY_NAME.test(displayName)) {
    fields.displayName = "invalid";
  }
  if (targetIds !== undefined) {
    if (
      !Array.isArray(targetIds) ||
      targetIds.length > MAX_LB_TARGETS ||
      !targetIds.every((t) => typeof t === "string" && UUID.test(t))
    ) {
      fields.targetIds = "invalid";
    }
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      productId: productId as string,
      region: region as string,
      displayName: displayName as string,
      targetIds: Array.isArray(targetIds) ? [...(targetIds as string[])] : [],
    },
  };
}

declare const checkedBrand: unique symbol;
/** Target ids that passed checkLbTargets. Only that function makes one (a branded type). */
export type CheckedTargets = readonly string[] & { readonly [checkedBrand]: true };

/** What the adapter learns about a requested target from the customer-scoped lookup. */
export interface TargetCandidate {
  readonly id: string;
  readonly customerId: string;
  readonly family: string;
  readonly state: string;
  /** The Region of the resource (its config.region). */
  readonly region: string;
}

const TARGETS_INVALID: Result<never> = Object.freeze({
  ok: false,
  error: "validation",
  fields: Object.freeze({ targetIds: "invalid" }),
}) as Result<never>;

/**
 * The rule of 10.3 and 16.10, pure (R8, R16). Every requested target must be one of the customer's
 * own instances, active, in the Region of the load balancer; between 1 and 20, no duplicates. A
 * candidate list entry of `null` is a target that was not found for this customer. Every failure
 * is the same answer, so another customer's id cannot be told from a missing one.
 */
export function checkLbTargets(input: {
  readonly customerId: string;
  readonly region: string;
  readonly requested: readonly string[];
  readonly candidates: readonly (TargetCandidate | null)[];
}): Result<CheckedTargets> {
  const { customerId, region, requested, candidates } = input;
  if (requested.length === 0 || requested.length > MAX_LB_TARGETS) return TARGETS_INVALID;
  if (new Set(requested).size !== requested.length) return TARGETS_INVALID;
  for (const id of requested) {
    if (!UUID.test(id)) return TARGETS_INVALID;
    const found = candidates.find((c) => c !== null && c.id === id);
    if (found === undefined || found === null) return TARGETS_INVALID;
    if (
      found.customerId !== customerId ||
      !INSTANCE_FAMILIES.includes(found.family) ||
      found.state !== "active" ||
      found.region !== region
    ) {
      return TARGETS_INVALID;
    }
  }
  return { ok: true, value: [...requested] as unknown as CheckedTargets };
}

function unavailable(): Result<never> {
  return { ok: false, error: "validation", fields: { productId: "unavailable" } };
}

/**
 * A load balancer row of the catalog (an admin-editable price row, 8). Fails closed. The targets of
 * the result are `checked`, never `config.targetIds`: the caller must have run checkLbTargets on
 * a customer-scoped read first (R8). resolveProduct does not know this family for that reason; the
 * order path resolves it in orders/checks.ts after the check.
 */
export function resolveLoadBalancer(
  config: LoadBalancerConfig,
  product: CatalogProduct,
  checked: CheckedTargets,
): Result<ResolvedLoadBalancer> {
  if (
    product.id !== config.productId ||
    product.family !== "load_balancer" ||
    !product.active ||
    product.region !== config.region
  ) {
    return unavailable();
  }
  return {
    ok: true,
    value: {
      family: "load_balancer",
      productId: product.id,
      region: product.region,
      featureFlag: product.featureFlag,
      awsPriceUsd: product.awsPriceUsd,
      facts: { bundleUsd: product.awsPriceUsd, windows: false, staticIps: 0 },
      needs: [{ quotaCode: "load_balancer", amount: 1 }],
      resourceConfig: {
        productId: config.productId,
        region: config.region,
        displayName: config.displayName,
        targetIds: [...checked],
      },
    },
  };
}
