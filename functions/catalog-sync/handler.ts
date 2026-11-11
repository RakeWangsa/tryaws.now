import {
  AwsError,
  toLogFields,
  type AccountRef,
  type CatalogSource,
  type LightsailRegion,
  type TldPrice,
} from "@tc/aws";
import { planIsSafe, planScopeSync, type CatalogRowInput, type Clock, type Logger } from "@tc/core";

/** The families this task syncs (open point 1). A later family adds a mapper and a source method. */
export const SYNC_FAMILIES = ["linux_instance", "windows_instance"] as const;
export const DEFAULT_BUDGET_MS = 240_000;
const FIXED_FAILURE = "catalog-sync: sync failed";

export interface ScopeWrite {
  readonly region: string;
  readonly rows: readonly CatalogRowInput[];
  readonly deactivate: readonly { family: string; awsId: string; region: string }[];
  readonly at: Date;
}

/**
 * What the handler needs of the database. Each method is its own short transaction in deps.ts, so no
 * connection is held during a network call. There is no delete: a plan AWS no longer lists is
 * deactivated (R5-style append-only spirit, open point 5).
 */
export interface CatalogStore {
  poolAccount(awsAccountId: string): Promise<AccountRef | null>;
  existing(scope: {
    region: string;
    families: readonly string[];
  }): Promise<{ family: string; awsId: string; active: boolean }[]>;
  apply(scope: ScopeWrite): Promise<{ inserted: number; updated: number; deactivated: number }>;
  applyTlds(rows: readonly TldPrice[], at: Date): Promise<{ inserted: number; updated: number }>;
}

export interface CatalogSyncDeps {
  readonly source: CatalogSource;
  readonly store: CatalogStore;
  readonly clock: Clock;
  readonly log: Logger;
  readonly poolAccountId: string;
  readonly dnsAccount: AccountRef | null;
  readonly regions: readonly LightsailRegion[];
  readonly syncTlds: boolean;
  /** Time after which no new scope starts (open point 10). Default 240000. */
  readonly budgetMs?: number;
}

export interface CatalogSyncReport {
  readonly regions: readonly {
    region: string;
    ok: boolean;
    seen: number;
    mapped: number;
    refused: number;
    active: number;
    inactiveIpv6: number;
    inserted: number;
    updated: number;
    deactivated: number;
  }[];
  readonly tlds: {
    ok: boolean;
    skipped: boolean;
    inserted: number;
    updated: number;
  } | null;
}

type FailReason = "failed" | "aws_error" | "unsafe_plan" | "budget";

class ScopeRefused extends Error {
  constructor(readonly reason: FailReason) {
    super(reason);
  }
}

const SAFE_WORD = /^[a-z_]{1,40}$/;

/** A fixed vocabulary only: never the text of an error (R3, R14). */
function failureFields(e: unknown): { reason: FailReason; errorCode?: string; awsReason?: string } {
  if (e instanceof ScopeRefused) return { reason: e.reason };
  if (e instanceof AwsError) {
    const f = toLogFields(e);
    return {
      reason: "aws_error",
      ...(typeof f.errorCode === "string" && SAFE_WORD.test(f.errorCode)
        ? { errorCode: f.errorCode }
        : {}),
      ...(typeof f.reason === "string" && SAFE_WORD.test(f.reason) ? { awsReason: f.reason } : {}),
    };
  }
  return { reason: "failed" };
}

const zero = (region: string, ok: boolean) => ({
  region,
  ok,
  seen: 0,
  mapped: 0,
  refused: 0,
  active: 0,
  inactiveIpv6: 0,
  inserted: 0,
  updated: 0,
  deactivated: 0,
});

/**
 * One run of the catalog sync. The event is never read: the schedule and the admin invoke send nothing
 * that matters, and a hostile event changes nothing. Scopes run in the configured order, each in its own
 * short transactions; a failed scope is logged with a fixed reason and the loop continues, and its rows
 * are untouched. The AWS read happens outside any transaction. When anything failed the run throws a
 * fixed message after the good scopes are written (R16). Logs hold counts, booleans and fixed words (R14).
 */
export function createCatalogSyncHandler(
  deps: CatalogSyncDeps,
): (event?: unknown) => Promise<CatalogSyncReport> {
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  return async (): Promise<CatalogSyncReport> => {
    const startedAt = deps.clock.now().getTime();
    const overBudget = () => deps.clock.now().getTime() - startedAt > budgetMs;

    const account: AccountRef | null = await deps.store
      .poolAccount(deps.poolAccountId)
      .catch(() => null);
    if (account === null) {
      deps.log({ event: "catalog_sync", result: "failed", reason: "pool_account" });
      throw new Error(FIXED_FAILURE);
    }

    const syncTldStep = async (): Promise<NonNullable<CatalogSyncReport["tlds"]>> => {
      try {
        if (deps.dnsAccount === null) throw new ScopeRefused("failed");
        if (overBudget()) throw new ScopeRefused("budget");
        const prices = await deps.source.tldPrices(deps.dnsAccount);
        const done = await deps.store.applyTlds(prices, deps.clock.now());
        deps.log({ event: "catalog_sync_tlds", ok: true, ...done });
        return { ok: true, skipped: false, ...done };
      } catch (e) {
        const f = failureFields(e);
        // The TLD source is not configured yet (open point 3): the half is skipped, the instance
        // plans are not failed because of it. Any other TLD failure is a failure of the run.
        const skipped = f.awsReason === "not_configured";
        deps.log({
          event: "catalog_sync_tlds",
          ok: false,
          skipped,
          reason: skipped ? "not_configured" : f.reason,
        });
        return { ok: false, skipped, inserted: 0, updated: 0 };
      }
    };

    const regions: CatalogSyncReport["regions"][number][] = [];
    for (const region of deps.regions) {
      try {
        if (overBudget()) throw new ScopeRefused("budget");
        const bundles = await deps.source.instanceBundles(account, region);
        const existing = await deps.store.existing({ region, families: SYNC_FAMILIES });
        const plan = planScopeSync({ region, families: SYNC_FAMILIES, bundles, existing });
        if (!planIsSafe(plan, existing.filter((e) => e.active).length)) {
          throw new ScopeRefused("unsafe_plan");
        }
        const done = await deps.store.apply({
          region,
          rows: plan.upserts,
          deactivate: plan.deactivate,
          at: deps.clock.now(),
        });
        const entry = {
          region,
          ok: true,
          seen: plan.counts.seen,
          mapped: plan.counts.mapped,
          refused: plan.counts.refused,
          active: plan.counts.active,
          inactiveIpv6: plan.counts.inactiveIpv6,
          inserted: done.inserted,
          updated: done.updated,
          deactivated: done.deactivated,
        };
        regions.push(entry);
        deps.log({ event: "catalog_sync_scope", ...entry });
      } catch (e) {
        regions.push(zero(region, false));
        deps.log({ event: "catalog_sync_scope", region, ok: false, ...failureFields(e) });
      }
    }

    const tlds: CatalogSyncReport["tlds"] = deps.syncTlds ? await syncTldStep() : null;

    const failedScopes = regions.filter((r) => !r.ok).length;
    const tldFailed = tlds !== null && !tlds.ok && !tlds.skipped;
    const ok = failedScopes === 0 && !tldFailed;
    deps.log({
      event: "catalog_sync",
      result: ok ? "ok" : "failed",
      regions: regions.length,
      regionsFailed: failedScopes,
      tldsFailed: tldFailed,
      tldsSkipped: tlds?.skipped === true,
      seen: regions.reduce((n, r) => n + r.seen, 0),
      mapped: regions.reduce((n, r) => n + r.mapped, 0),
      refused: regions.reduce((n, r) => n + r.refused, 0),
      inserted: regions.reduce((n, r) => n + r.inserted, 0),
      updated: regions.reduce((n, r) => n + r.updated, 0),
      deactivated: regions.reduce((n, r) => n + r.deactivated, 0),
    });
    if (!ok) throw new Error(FIXED_FAILURE);
    return { regions, tlds };
  };
}
