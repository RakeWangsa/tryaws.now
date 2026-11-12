import { and, eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { settings } from "../../schema/index";
import { isMarketCode } from "./args";

// The image allow-list (WPU-G3): the explicit switches an admin set for the Lightsail blueprints of a
// market. One row of `settings`, key `image_allowlist`, scope 'market', value
//
//   { "v": 1, "on": ["<blueprint id>", ...], "off": ["<blueprint id>", ...] }
//
// The two lists are disjoint. An id in neither follows the default list of @tc/core. Written only by
// adminRepos.blueprints.setEnabled (audited); read by the panel (web_rw) and the functions (worker_rw),
// which already have SELECT on these columns of `settings`.

export const IMAGE_ALLOWLIST_KEY = "image_allowlist";
export const IMAGE_ALLOWLIST_VERSION = 1;
/** The longest list; an admin switches a few dozen images at most. */
export const IMAGE_ALLOWLIST_MAX = 200;

const BLUEPRINT_ID = /^[a-z0-9_]{1,64}$/;

export interface ImageSwitches {
  readonly on: readonly string[];
  readonly off: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > IMAGE_ALLOWLIST_MAX) return null;
  const out: string[] = [];
  for (const id of value as unknown[]) {
    if (typeof id !== "string" || !BLUEPRINT_ID.test(id) || out.includes(id)) return null;
    out.push(id);
  }
  return out;
}

/** The switches of a stored value, or null when anything in it is wrong: a bad row is not a list (R16). */
export function parseImageSwitches(value: unknown): ImageSwitches | null {
  if (!isObject(value) || value.v !== IMAGE_ALLOWLIST_VERSION) return null;
  const on = idList(value.on);
  const off = idList(value.off);
  if (on === null || off === null || on.some((id) => off.includes(id))) return null;
  return { on, off };
}

export function imageSwitchesValueOf(switches: ImageSwitches): unknown {
  return { v: IMAGE_ALLOWLIST_VERSION, on: [...switches.on], off: [...switches.off] };
}

export type ImageSwitchesRead =
  | { readonly state: "none" }
  | { readonly state: "invalid" }
  | { readonly state: "ok"; readonly switches: ImageSwitches };

/**
 * The stored switches of a market. `invalid` is a row that does not parse: the caller offers no image
 * (R16) instead of guessing. Not tenant data. Messages hold no input (R14).
 */
export async function readImageSwitches(tx: Tx, market: string): Promise<ImageSwitchesRead> {
  if (!isMarketCode(market)) throw new TypeError("readImageSwitches: market is invalid");
  const rows = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, IMAGE_ALLOWLIST_KEY),
        eq(settings.market, market),
        eq(settings.scope, "market"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { state: "none" };
  const switches = parseImageSwitches(row.value);
  return switches === null ? { state: "invalid" } : { state: "ok", switches };
}
