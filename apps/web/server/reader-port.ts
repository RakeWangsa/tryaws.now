import type { ReaderPort } from "./extras-view.ts";
import { getRuntime } from "./runtime.ts";

/**
 * The binding of the `reader` function for the Metrics tab (WPU-G4): the invoke port of
 * reader-invoke.ts, built once by the runtime. The web tier has no AWS client for provisioning (R1).
 * null = not configured, and the tab shows its "not available" state (R16); a runtime that cannot be
 * built is the same.
 */
export async function getReaderPort(): Promise<ReaderPort | null> {
  try {
    return (await getRuntime()).reader;
  } catch {
    return null;
  }
}
