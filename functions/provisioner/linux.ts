import { readLaunchInputs, withTx } from "@tc/db";
import {
  createBeaconMarker,
  createLinuxInstanceAdapter,
  parseProbeSources,
  withBackups,
  type LinuxInstanceDeps,
} from "@tc/aws";
import { DEFAULT_BLUEPRINT_ID } from "@tc/core";
import type { ProductAdapter } from "@tc/aws";
import { backupDeps } from "./backup";

// Not in the catalog row (WP4-T5 open point 1): one blueprint for every Linux instance until the
// catalog or the config carries it. VERIFY the id with GetBlueprints in tc-pool-dev. The constant
// lives in @tc/core so that the Connect tab names the login user of the same image (WPU-G13).
export { DEFAULT_BLUEPRINT_ID };

export interface LinuxWiring {
  readonly vpcCidr?: string | null;
  /**
   * WPU-G1. The public addresses of the platform (the NAT gateways of the VPC) as a comma list of
   * CIDRs, from the environment TC_PROBE_SOURCES. The beacon port of a new instance is opened to
   * them only, while the create waits for the marker. Missing or unsafe = the create fails closed.
   */
  readonly probeSources?: string | null;
}

// The production dependencies of the adapter. WPU-G1: the bootstrap marker is read through the
// beacon of the instance (decision 110, option a): the probe connects to the public address that
// AWS reported and accepts only the exact marker. No marker, no static IP and no hand-over (R16);
// the adapter bounds the waiting. Exported for the wiring test.
export function linuxDeps(wiring: LinuxWiring = {}): LinuxInstanceDeps {
  const sources = parseProbeSources(wiring.probeSources ?? undefined);
  return {
    loadLaunch: async ({ customerId, productId, keyPairId }) => {
      const found = await withTx((tx) =>
        readLaunchInputs(tx, { customerId, productId, keyPairId }),
      );
      return found === null
        ? null
        : {
            bundleId: found.bundleId,
            blueprintId: DEFAULT_BLUEPRINT_ID,
            publicKey: found.publicKey,
          };
    },
    vpcCidr: async () => wiring.vpcCidr ?? null,
    beaconSources: async () => sources,
    bootstrapMarker: createBeaconMarker(),
  };
}

export function linuxInstanceAdapter(wiring: LinuxWiring = {}): ProductAdapter<unknown> {
  const deps = linuxDeps(wiring);
  // WP5-T1: automatic backups, restore to a new server, the final snapshot and the purge.
  return withBackups(
    createLinuxInstanceAdapter(deps),
    backupDeps(),
    deps,
  ) as ProductAdapter<unknown>;
}
