import { staticIpHourPrice, staticIpIsCharging } from "@tc/core";
import type { Tx } from "@tc/db";

// WPU-M1. What the Static IPs page and the Networking tab say about the charge of an unattached static IP:
// Amazon Lightsail charges nothing while it is attached and an hourly price once it has been unattached
// for more than one hour. The price comes from the pricing engine (a bigint of paisa, sent as digit text,
// R4); with no usable price the screens say it is not available instead of a number (R16).

export interface StaticIpFee {
  /** Paisa for one hour as digit text, or null when no price is in force. */
  hourMinor: string | null;
  /** The IP is not attached and the free hour is over: the hourly charge is running. */
  charging: boolean;
}

export async function loadStaticIpHourMinor(tx: Tx, market: string): Promise<string | null> {
  const found = await staticIpHourPrice(tx, market, { now: () => new Date() });
  return found.ok ? found.value.perHourMinor.toString() : null;
}

export function staticIpFeeOf(
  rawConfig: unknown,
  hourMinor: string | null,
  now: Date = new Date(),
): StaticIpFee {
  const config =
    typeof rawConfig === "object" && rawConfig !== null
      ? (rawConfig as Record<string, unknown>)
      : {};
  if (config["staticIpAttached"] !== false) return { hourMinor, charging: false };
  const raw = config["detachedAt"];
  const at = typeof raw === "string" ? new Date(raw) : null;
  const exact = at !== null && !Number.isNaN(at.getTime()) && at.toISOString() === raw;
  return { hourMinor, charging: exact && staticIpIsCharging(at, now) };
}
