import { createWindowsInstanceAdapter, type WindowsInstanceDeps } from "@tc/aws";
import type { ProductAdapter } from "@tc/aws";
import { readCatalogProduct, withTx } from "@tc/db";

// Not in the catalog row, like the Linux one: a single blueprint until the catalog or the config
// carries it. VERIFY the id with GetBlueprints in tc-pool-dev before a Windows product is listed.
export const DEFAULT_WINDOWS_BLUEPRINT_ID = "windows_server_2022";

export interface WindowsWiring {
  readonly vpcCidr?: string | null;
  /** The DHCP server address of the subnet. VERIFY; without it the bootstrap is strict. */
  readonly dhcpServer?: string | null;
}

// The production dependencies of the Windows adapter. The catalog row decides (R16): only an active
// product of the family `windows_instance` with the platform `windows` is a Windows bundle. The marker
// probe is a VERIFY item with no production mechanism yet, so it answers "absent": a create stops
// before the static IP and never hands over an instance whose firewall is not proven.
export function windowsInstanceAdapter(wiring: WindowsWiring = {}): ProductAdapter<unknown> {
  const deps: WindowsInstanceDeps = {
    loadLaunch: async ({ productId }) => {
      const product = await withTx((tx) => readCatalogProduct(tx, productId));
      if (
        product === null ||
        product.family !== "windows_instance" ||
        product.platform !== "windows" ||
        !product.active
      ) {
        return null;
      }
      return { bundleId: product.awsId, blueprintId: DEFAULT_WINDOWS_BLUEPRINT_ID };
    },
    vpcCidr: async () => wiring.vpcCidr ?? null,
    dhcpServer: async () => wiring.dhcpServer ?? null,
    bootstrapMarker: async () => "absent",
  };
  return createWindowsInstanceAdapter(deps) as ProductAdapter<unknown>;
}
