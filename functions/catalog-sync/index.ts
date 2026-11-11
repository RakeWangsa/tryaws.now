// catalog-sync: once a day reads the Lightsail bundles (read-only, role TcReader) and the Route 53 Domains
// price list (role TcDnsReader) and upserts catalog_products and tlds (spec 08). This file is the only place
// that touches the process: environment, clock and the log sink. The function links no secret, so there is no sst
// import here.
//
// Not wired here (infra, WP0-T4; hand-off list in JOURNEY.md, entry WP1-T5): the schedule (EventBridge
// Scheduler, rate(1 day), retry policy 0), the admin invoke permission, the execution role (AssumeRole of
// TcReader and TcDnsReader only), the roles in tc-pool-dev and tc-dns, the four plain settings, the alarms.
// Nothing here depends on the cadence for correctness.
import { createAwsAccess } from "@tc/aws";
import { withTx } from "@tc/db";
import { readConfig } from "./config";
import { buildCatalogSyncDeps } from "./deps";
import type { CatalogSyncReport } from "./handler";

// Built on the first call, not at import; a failed build keeps nothing (R16).
let inner: ((event?: unknown) => Promise<CatalogSyncReport>) | undefined;

export const handler = async (event?: unknown): Promise<CatalogSyncReport> => {
  if (inner === undefined) {
    const config = readConfig(process.env);
    inner = buildCatalogSyncDeps({
      config,
      access: createAwsAccess({ caller: "catalog-sync" }),
      runTx: withTx,
      clock: { now: () => new Date() },
      log: (e) => console.log(JSON.stringify(e)),
    }).handler;
  }
  return inner(event);
};
