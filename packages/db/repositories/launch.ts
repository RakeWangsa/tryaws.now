import { and, eq } from "drizzle-orm";
import type { Tx } from "../client";
import { catalogProducts, sshKeys } from "../schema/index";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LaunchInputs {
  readonly bundleId: string;
  /** null when the key does not exist or belongs to another customer (R8). */
  readonly publicKey: string | null;
}

/**
 * What the Linux instance adapter needs to launch: the catalog bundle id and the public key of the
 * customer's own SSH key. The key row is read with the customer id in the same statement (R8): a
 * key of another customer and a missing key both give `publicKey: null`. Only worker_rw columns
 * (id, customer_id, public_key, fingerprint) are read. The blueprint is not in the catalog row; the
 * caller supplies it.
 */
export async function readLaunchInputs(
  tx: Tx,
  input: { customerId: string; productId: string; keyPairId: string | null },
): Promise<LaunchInputs | null> {
  const { customerId, productId, keyPairId } = input;
  if (!UUID.test(customerId) || !UUID.test(productId)) return null;
  const products = await tx
    .select({ awsId: catalogProducts.awsId, family: catalogProducts.family })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, productId))
    .limit(1);
  const product = products[0];
  if (product === undefined || product.family !== "linux_instance") return null;
  let publicKey: string | null = null;
  if (keyPairId !== null && UUID.test(keyPairId)) {
    const keys = await tx
      .select({ publicKey: sshKeys.publicKey })
      .from(sshKeys)
      .where(and(eq(sshKeys.id, keyPairId), eq(sshKeys.customerId, customerId)))
      .limit(1);
    publicKey = keys[0]?.publicKey ?? null;
  }
  return { bundleId: product.awsId, publicKey };
}
