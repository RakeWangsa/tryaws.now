import type { ReaderPort } from "./extras-view.ts";

/**
 * The binding of the `reader` function for the Metrics tab. The web tier has no AWS client and no
 * Lambda client (R1, no new dependency), so until the invoke binding of WP0-T4 exists this answers
 * null and the tab shows its "not available" state (R16). See JOURNEY.md, WP5-T6, Needs decision.
 */
export function getReaderPort(): ReaderPort | null {
  return null;
}
