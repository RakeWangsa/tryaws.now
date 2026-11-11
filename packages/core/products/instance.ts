import type { CatalogProduct } from "@tc/db";
import type { CapacityNeed } from "../capacity/types";
import type { ProductFacts } from "../orders/gates";
import type { Result } from "../types";
import { parseDatabaseConfig, resolveDatabase } from "./database";
import { parseLoadBalancerConfig, resolveLoadBalancer } from "./load-balancer";

export interface InstanceConfig {
  readonly productId: string;
  readonly region: string;
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string;
  readonly keyPairId: string | null;
}

export interface ResolvedProduct {
  readonly family: "linux_instance" | "database" | "load_balancer";
  readonly productId: string;
  readonly region: string;
  readonly featureFlag: string;
  readonly awsPriceUsd: string;
  readonly quantity?: string;
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

/**
 * Hand-written, collects every invalid field. Unknown keys, `capacityReservation` and `awsName`
 * are dropped, never copied: the result holds the four known fields only (open point 12).
 */
export function parseInstanceConfig(raw: unknown): Result<InstanceConfig> {
  const input = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const { productId, region, displayName, keyPairId } = input;
  if (typeof productId !== "string" || !UUID.test(productId)) fields.productId = "invalid";
  if (typeof region !== "string" || !REGION.test(region)) fields.region = "invalid";
  if (typeof displayName !== "string" || !DISPLAY_NAME.test(displayName)) {
    fields.displayName = "invalid";
  }
  if (keyPairId !== undefined && keyPairId !== null) {
    if (typeof keyPairId !== "string" || !UUID.test(keyPairId)) fields.keyPairId = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      productId: productId as string,
      region: region as string,
      displayName: displayName as string,
      keyPairId: typeof keyPairId === "string" ? keyPairId : null,
    },
  };
}

function unavailable(): Result<never> {
  return { ok: false, error: "validation", fields: { productId: "unavailable" } };
}

function positiveVcpus(specs: unknown): number | null {
  if (!isRecord(specs)) return null;
  const vcpus = specs.vcpus;
  return typeof vcpus === "number" && Number.isSafeInteger(vcpus) && vcpus > 0 ? vcpus : null;
}

/**
 * Turns a validated config and its catalog row into what the purchase needs. An instance is sold
 * with its static IP, so `needs` holds both (open point 12). Fails closed on any surprise in the row.
 */
export function resolveInstance(
  config: InstanceConfig,
  product: CatalogProduct,
): Result<ResolvedProduct> {
  if (
    product.id !== config.productId ||
    product.family !== "linux_instance" ||
    !product.active ||
    product.region !== config.region ||
    (product.platform !== "linux" && product.platform !== "windows")
  ) {
    return unavailable();
  }
  const vcpus = positiveVcpus(product.specs);
  if (vcpus === null) return unavailable();
  return {
    ok: true,
    value: {
      family: "linux_instance",
      productId: product.id,
      region: product.region,
      featureFlag: product.featureFlag,
      awsPriceUsd: product.awsPriceUsd,
      facts: {
        bundleUsd: product.awsPriceUsd,
        windows: product.platform === "windows",
        staticIps: 1,
      },
      needs: [
        { quotaCode: "instance_vcpu", amount: vcpus },
        { quotaCode: "static_ip", amount: 1 },
      ],
      resourceConfig: {
        productId: config.productId,
        region: config.region,
        displayName: config.displayName,
        keyPairId: config.keyPairId,
      },
    },
  };
}

/**
 * One switch with one case. Each later work package adds the case of its family; every other
 * family is `unsupported` and nothing is loaded for it.
 */
export async function resolveProduct(
  family: string,
  rawConfig: unknown,
  load: (id: string) => Promise<CatalogProduct | null>,
): Promise<Result<ResolvedProduct>> {
  switch (family) {
    case "linux_instance": {
      const config = parseInstanceConfig(rawConfig);
      if (!config.ok) return config;
      const product = await load(config.value.productId);
      if (product === null) return unavailable();
      return resolveInstance(config.value, product);
    }
    case "database": {
      const config = parseDatabaseConfig(rawConfig);
      if (!config.ok) return config;
      const product = await load(config.value.productId);
      if (product === null) return unavailable();
      return resolveDatabase(config.value, product);
    }
    case "load_balancer": {
      const config = parseLoadBalancerConfig(rawConfig);
      if (!config.ok) return config;
      const product = await load(config.value.productId);
      if (product === null) return unavailable();
      return resolveLoadBalancer(config.value, product);
    }
    default:
      return { ok: false, error: "validation", fields: { family: "unsupported" } };
  }
}
