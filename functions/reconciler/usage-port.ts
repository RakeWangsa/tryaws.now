import {
  createAwsAccess,
  createLightsailUsageSource,
  toAwsError,
  toLogFields,
  type UsageSource,
} from "@tc/aws";
import type { Clock, Logger, RunTx } from "@tc/core";
import { readFeatureFlag, type PoolAccountRef } from "@tc/db";
import type { InventoryFailure, InventoryPort, InventoryResult } from "./inventory";

// WPU-X4. Adds the real usage (snapshot GB, data transfer GB) to an inventory port. The usage comes from
// the Lightsail reader of @tc/aws (TcReader by STS AssumeRole, R3); this file only joins it to the port of
// the reconciler (contract unchanged: InventoryRead.usage is optional and already consumed by
// reconcile.ts / planUsageWrites).
//
// Fail closed (R16): when the base read failed, its failure is passed on. When the usage read fails, the
// whole account is reported as not read; the metering run then charges nothing for what was not read, and
// the reconcile run is incomplete and alarms. When no family that has metered usage is on, usage is left
// out and nothing is called (R12).

/** The families that have metered usage: snapshots (backup) and servers (data transfer). */
export const USAGE_FLAGS = Object.freeze(["backup", "linux_instance", "windows_instance"] as const);
const MARKET = "BD";

/** True when any metered family is on. An unreadable flag is off (R16: nothing is called). */
export function usageFlagsEnabled(runTx: RunTx): () => Promise<boolean> {
  return async () => {
    try {
      return await runTx(async (tx) => {
        for (const key of USAGE_FLAGS) {
          if ((await readFeatureFlag(tx, key, MARKET)) === true) return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  };
}

function failureOf(error: unknown): InventoryFailure {
  const e = toAwsError(error, null);
  if (e.reason === "usage_pages_exceeded" || e.reason === "usage_response_invalid") {
    return "incomplete";
  }
  if (e.code === "unauthenticated" || e.code === "forbidden") return "denied";
  if (e.code === "rate_limited") return "throttled";
  return "unreachable";
}

export interface UsageInventoryDeps {
  readonly base: InventoryPort;
  readonly source: UsageSource;
  readonly enabled: () => Promise<boolean>;
  readonly log: Logger;
}

export function withUsage(deps: UsageInventoryDeps): InventoryPort {
  return {
    async read(account: PoolAccountRef): Promise<InventoryResult> {
      const base = await deps.base.read(account);
      if (!base.ok) return base;
      if (!(await deps.enabled())) return base;
      try {
        const usage = await deps.source.read({
          awsAccountId: account.awsAccountId,
          externalId: account.externalId,
        });
        return { ok: true, value: { ...base.value, usage } };
      } catch (error) {
        const reason = failureOf(error);
        // Platform ids and fixed fields only: no AWS account id, no raw AWS text (R14).
        deps.log({
          ...toLogFields(toAwsError(error, null)),
          event: "reconcile_usage_read_failed",
          severity: "alert",
          poolAccountId: account.id,
          reason,
        });
        return { ok: false, reason };
      }
    },
  };
}

/** The production usage inventory: the Lightsail reader behind the flags, over any base port. */
export function buildUsageInventory(
  base: InventoryPort,
  env: { readonly clock: Clock; readonly runTx: RunTx; readonly log: Logger },
): InventoryPort {
  const access = createAwsAccess({ caller: "reconciler", clock: env.clock });
  return withUsage({
    base,
    source: createLightsailUsageSource(access, env.clock),
    enabled: usageFlagsEnabled(env.runTx),
    log: env.log,
  });
}
