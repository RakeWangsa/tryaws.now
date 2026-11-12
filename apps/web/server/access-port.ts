import type { AccessPort } from "./access-invoke.ts";
import { getRuntime } from "./runtime.ts";

/**
 * The binding of the `access-details` function (WPU-N2): the invoke port of access-invoke.ts, built
 * once by the runtime. The web tier has no AWS client for provisioning (R1). null = not configured,
 * and every reveal and key action refuses (R16); a runtime that cannot be built is the same.
 */
export async function getAccessPort(): Promise<AccessPort | null> {
  try {
    return (await getRuntime()).access;
  } catch {
    return null;
  }
}
