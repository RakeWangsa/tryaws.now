import { readImage, readLaunchInputs, withTx } from "@tc/db";
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

// WPU-G3: the image is the one the customer chose (the order configuration carries its id; the order
// code checked it against the admin allow-list). An order that has none (older orders) is launched
// with the default image. The constant lives in @tc/core so that the Connect tab names the login user
// of the same image (WPU-G13). VERIFY the ids with GetBlueprints in tc-pool-dev.
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
    loadLaunch: async ({ customerId, productId, keyPairId, blueprintId, region }) => {
      return withTx(async (tx) => {
        const found = await readLaunchInputs(tx, { customerId, productId, keyPairId });
        if (found === null) return null;
        if (blueprintId === null) {
          return {
            bundleId: found.bundleId,
            blueprintId: DEFAULT_BLUEPRINT_ID,
            publicKey: found.publicKey,
          };
        }
        // A paid server is made from the image that was sold, even if an admin switched it off since
        // (the switch only stops new orders). It must still exist and be active at AWS in the Region:
        // otherwise the create fails closed (R16) and the order is refunded.
        const image = await readImage(tx, region, blueprintId);
        if (image === null || !image.active) return null;
        return { bundleId: found.bundleId, blueprintId, publicKey: found.publicKey };
      });
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
