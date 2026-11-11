import { adminRepos, type AdminActor, type Tx } from "@tc/db";
import { isMarketText, marketProblem, reasonProblem } from "../rates/common";
import type { Result } from "../types";
import { isFeatureFlag, type FeatureFlag } from "./keys";

export interface SetFeatureFlagInput {
  key: string;
  market: string;
  enabled: boolean;
  reason: string;
}

export interface SavedFeatureFlag {
  key: FeatureFlag;
  market: string;
  enabled: boolean;
  replayed: boolean;
}

/**
 * Switches a product family on or off for a market. R10: the write is audited by the repository
 * (actor, reason, IP, target). No role check (open point 8): the action does that.
 */
export async function setFeatureFlag(
  tx: Tx,
  actor: AdminActor,
  input: SetFeatureFlagInput,
): Promise<Result<SavedFeatureFlag>> {
  const { key, market, enabled, reason } = input;
  const fields: Record<string, string> = {};
  if (!isFeatureFlag(key)) fields.key = "unknown";
  if (!isMarketText(market)) fields.market = "invalid";
  if (typeof enabled !== "boolean") fields.enabled = "invalid";
  const why = reasonProblem(reason);
  if (why !== null) fields.reason = why;
  if (!isFeatureFlag(key) || Object.keys(fields).length > 0) {
    return { ok: false, error: "validation", fields };
  }

  const unknown = await marketProblem(tx, market);
  if (unknown !== null) return { ok: false, error: "validation", fields: { market: unknown } };

  const written = await adminRepos(tx, actor).featureFlags.set({ key, market, enabled }, reason);
  if (!written.ok) return { ok: false, error: "validation", fields: { key: "invalid" } };
  return {
    ok: true,
    value: { key, market, enabled: written.value.enabled, replayed: written.replayed },
  };
}
