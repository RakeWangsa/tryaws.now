// payments-sweeper: every 5 minutes asks EPS about payments whose browser never came back (9.2.4).
// This file is the only place that touches the process: environment, clock, fetch, console, SST.
//
// Not wired here (infra, WP0-T4; hand-off list in docs/superpowers/plans/wp3-t3-open-points.md, point 8):
// the schedule (EventBridge Scheduler, rate(5 minutes), retry policy 0), the five secret links, NAT egress
// to EPS, and the IAM role (no pool-account role). Nothing here depends on the cadence for correctness.
import { randomBytes } from "node:crypto";
import { withTx } from "@tc/db";
import { buildSweeper } from "./deps";
import { readConfig } from "./config";
import type { SweeperReport } from "./handler";
import { sstSecrets } from "./secrets";

// The seam to SST's linked Resource. The `sst` package is not a dependency of this repo yet (open point 3),
// so there is no static import. When the import fails the build fails closed (R16).
async function loadSstResource(): Promise<Record<string, { value: string } | undefined>> {
  try {
    const mod = (await import("sst" as string)) as { Resource: Record<string, never> };
    return mod.Resource as Record<string, { value: string } | undefined>;
  } catch {
    throw new Error("sweeper: secrets are not linked");
  }
}

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ((event?: unknown) => Promise<SweeperReport>) | undefined;

export const handler = async (event?: unknown): Promise<SweeperReport> => {
  if (inner === undefined) {
    const config = readConfig(process.env);
    const secrets = await sstSecrets(loadSstResource);
    // WPU-Z11: an EPS secret on the placeholder (EPS not configured) gives a job that asks EPS nothing.
    inner = buildSweeper({
      config,
      secrets,
      fetch: globalThis.fetch.bind(globalThis),
      clock: { now: () => new Date() },
      runTx: withTx,
      log: (e) => console.log(JSON.stringify(e)),
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
    });
  }
  return inner(event);
};
