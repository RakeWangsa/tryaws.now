import { createCatalogSource, type AccountRef, type AwsAccess, type CatalogSource } from "@tc/aws";
import type { Clock, Logger } from "@tc/core";
import { applyCatalogScope, applyTlds, listCatalogKeys, readPoolAccountRef, type Tx } from "@tc/db";
import type { CatalogSyncConfig } from "./config";
import { createCatalogSyncHandler, type CatalogStore } from "./handler";

export interface CatalogSyncEnv {
  readonly config: CatalogSyncConfig;
  readonly access: AwsAccess<"catalog-sync">;
  readonly runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly clock: Clock;
  readonly log: Logger;
  /** Tests only: replaces the AWS source. */
  readonly source?: CatalogSource;
}

/**
 * Assembles the handler from values handed in: no environment access and no global clock. Every store
 * method is its own short transaction, so no database connection is held while AWS is called.
 */
export function buildCatalogSyncDeps(env: CatalogSyncEnv): {
  handler: ReturnType<typeof createCatalogSyncHandler>;
} {
  const { config, runTx } = env;
  const store: CatalogStore = {
    poolAccount: (awsAccountId) => runTx((tx) => readPoolAccountRef(tx, awsAccountId)),
    existing: (scope) => runTx((tx) => listCatalogKeys(tx, scope)),
    apply: (scope) =>
      runTx((tx) =>
        applyCatalogScope(tx, { rows: scope.rows, deactivate: scope.deactivate, at: scope.at }),
      ),
    applyTlds: (rows, at) => runTx((tx) => applyTlds(tx, { rows, at })),
  };
  const dnsAccount: AccountRef | null =
    config.dnsAccountId !== null && config.dnsExternalId !== null
      ? { awsAccountId: config.dnsAccountId, externalId: config.dnsExternalId }
      : null;
  const handler = createCatalogSyncHandler({
    source: env.source ?? createCatalogSource(env.access),
    store,
    clock: env.clock,
    log: env.log,
    poolAccountId: config.poolAccountId,
    dnsAccount,
    regions: config.regions,
    syncTlds: config.syncTlds,
  });
  return { handler };
}
