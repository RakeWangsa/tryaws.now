import type { UnrecordedCharge } from "@tc/db";
import { readChargeSnapshot } from "../pricing/charge-snapshot";
import { parseSnapshot } from "../pricing/snapshot";
import type { InvoiceLine } from "./base";
import { invoiceLinesOf } from "./charge";
import { resolveChargeLines } from "./charge-lines";

/**
 * WPU-Y9. What to queue for an unrecorded charge, or null when it can only be noted. The lines come from the
 * snapshot saved with the charge (resolveChargeLines), never from a rate read now, so a rate change after the
 * charge cannot change the invoice. A legacy order (no saved snapshot) is built from the snapshot of its order
 * row, as before; a legacy renewal has nothing to build from and is noted. A damaged snapshot is null (R16).
 */
export function backlogEntryOf(charge: UnrecordedCharge): {
  kind: "order" | "renewal";
  orderId: string | null;
  lines: InvoiceLine[];
} | null {
  try {
    const read = readChargeSnapshot(charge.chargeSnapshot);
    if (read.state === "snapshot") {
      const lines = resolveChargeLines(charge.chargeSnapshot, []).lines;
      if (charge.kind === "order") {
        return charge.orderId === null ? null : { kind: "order", orderId: charge.orderId, lines };
      }
      return { kind: "renewal", orderId: null, lines };
    }
    if (read.state === "legacy" && charge.kind === "order" && charge.orderId !== null) {
      return {
        kind: "order",
        orderId: charge.orderId,
        lines: invoiceLinesOf(parseSnapshot(charge.priceSnapshot)),
      };
    }
  } catch {
    // the lines cannot be rebuilt: the caller writes the notice
  }
  return null;
}
