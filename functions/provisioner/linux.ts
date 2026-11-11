import { createLinuxInstanceAdapter, type LinuxInstanceDeps } from "@tc/aws";
import { readLaunchInputs, withTx } from "@tc/db";
import type { ProductAdapter } from "@tc/aws";

// Not in the catalog row (WP4-T5 open point 1): one blueprint for every Linux instance until the
// catalog or the config carries it. VERIFY the id with GetBlueprints in tc-pool-dev.
export const DEFAULT_BLUEPRINT_ID = "ubuntu_24_04";

export interface LinuxWiring {
  readonly vpcCidr?: string | null;
}

// The production dependencies of the adapter. The marker probe is a VERIFY item with no production
// mechanism yet, so it answers "absent": a create stops before the static IP and never hands over an
// instance whose firewall is not proven (R16). WP4-T5 open point 2.
export function linuxInstanceAdapter(wiring: LinuxWiring = {}): ProductAdapter<unknown> {
  const deps: LinuxInstanceDeps = {
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
    bootstrapMarker: async () => "absent",
  };
  return createLinuxInstanceAdapter(deps) as ProductAdapter<unknown>;
}
