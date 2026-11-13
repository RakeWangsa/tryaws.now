import { and, eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { settings } from "../../schema/index";
import { isMarketCode } from "./args";

// The image allow-list (WPU-G3): the explicit switches an admin set for the Lightsail blueprints of a
// market. One row of `settings`, key `image_allowlist`, scope 'market', value
//
//   { "v": 1, "on": ["<blueprint id>", ...], "off": ["<blueprint id>", ...],
//     "minPower": { "<blueprint id>": <whole number> } }          (minPower is optional, WPU-G10)
//
// `minPower` is the admin's own minimum bundle power for an image (the unit of GetBundles `power`: 298 is
// the 512 MB plan, 500 the 1 GB plan, 1000 the 2 GB plan; WPU-Z19); it replaces the value AWS reported for the blueprint. 0 means every plan. The two
// lists are disjoint. An id in neither follows the default list of @tc/core. Written only by
// adminRepos.blueprints.setEnabled (audited); read by the panel (web_rw) and the functions (worker_rw),
// which already have SELECT on these columns of `settings`.

export const IMAGE_ALLOWLIST_KEY = "image_allowlist";
export const IMAGE_ALLOWLIST_VERSION = 1;
/** The longest list; an admin switches a few dozen images at most. */
export const IMAGE_ALLOWLIST_MAX = 200;

const BLUEPRINT_ID = /^[a-z0-9_]{1,64}$/;

/** The largest minimum an admin can set; the biggest Lightsail bundle is far below it. */
export const IMAGE_MIN_POWER_MAX = 100000;

export interface ImageSwitches {
  readonly on: readonly string[];
  readonly off: readonly string[];
  /** The admin's minimum bundle power for an image; absent when none was set. */
  readonly minPower?: Readonly<Record<string, number>>;
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

function minPowerMap(value: unknown): Record<string, number> | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > IMAGE_ALLOWLIST_MAX) return null;
  const out: Record<string, number> = {};
  for (const [id, power] of entries) {
    if (!BLUEPRINT_ID.test(id)) return null;
    if (
      typeof power !== "number" ||
      !Number.isSafeInteger(power) ||
      power < 0 ||
      power > IMAGE_MIN_POWER_MAX
    ) {
      return null;
    }
    out[id] = power;
  }
  return out;
}

/** The switches of a stored value, or null when anything in it is wrong: a bad row is not a list (R16). */
export function parseImageSwitches(value: unknown): ImageSwitches | null {
  if (!isObject(value) || value.v !== IMAGE_ALLOWLIST_VERSION) return null;
  const on = idList(value.on);
  const off = idList(value.off);
  if (on === null || off === null || on.some((id) => off.includes(id))) return null;
  if (value.minPower === undefined) return { on, off };
  const minPower = minPowerMap(value.minPower);
  if (minPower === null) return null;
  return Object.keys(minPower).length === 0 ? { on, off } : { on, off, minPower };
}

export function imageSwitchesValueOf(switches: ImageSwitches): unknown {
  const minPower = switches.minPower ?? {};
  return {
    v: IMAGE_ALLOWLIST_VERSION,
    on: [...switches.on],
    off: [...switches.off],
    ...(Object.keys(minPower).length === 0 ? {} : { minPower: { ...minPower } }),
  };
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
