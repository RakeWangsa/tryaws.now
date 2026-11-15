import { EMPTY_ALLOW_LIST, offeredImages } from "@tc/core";
import type { BlueprintCatalogRow, BlueprintKind, ImageAllowList } from "@tc/core";
import { listActiveImages, readFeatureFlags, readImageSwitches, withTx } from "@tc/db";
import type { ImageSwitchesRead, Tx } from "@tc/db";
import { writeLog } from "../log.ts";
import { PUBLIC_MARKET } from "./catalog.ts";

// WPU-X22 item 4: the images (Lightsail blueprints, 16.13 "Image") the public home chooser shows. The
// same allow-list the panel create screen reads (servers-view.ts `loadConfigurator`): an image is
// offered when it is active in the Region and switched on by an admin. No customer data is involved
// (R8 does not apply), nothing is written and AWS is not called (R1): this reads two tables of the
// catalog and one market setting. The family flag is the plans' flag (R12), and anything that cannot be
// read hides the section (R16). Only what a visitor may see leaves this file: the name, the version and
// the kind, no login user, no AWS id of an account, no power.

/** The locations of the home chooser (the same two as `HOME_REGIONS` of the home page). */
export const PUBLIC_IMAGE_REGIONS: readonly string[] = Object.freeze([
  "ap-southeast-1",
  "ap-south-1",
]);

/** An image as the public page shows it (plain text only; U13: no logo). */
export interface PublicImage {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly kind: BlueprintKind;
}

export type PublicImages =
  | { readonly state: "unavailable" }
  | {
      readonly state: "ok";
      /** The offered images of each Region asked for, each list sorted by name. */
      readonly byRegion: Readonly<Record<string, readonly PublicImage[]>>;
    };

export interface ImagesDeps {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  flags(tx: Tx, market: string): Promise<{ key: string; enabled: boolean }[]>;
  switches(tx: Tx, market: string): Promise<ImageSwitchesRead>;
  active(tx: Tx, region: string): Promise<readonly BlueprintCatalogRow[]>;
}

export const defaultImagesDeps: ImagesDeps = {
  run: withTx,
  flags: readFeatureFlags,
  switches: readImageSwitches,
  active: listActiveImages,
};

const byName = (a: PublicImage, b: PublicImage): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The offered images of the given Regions. A family flag that is off or unreadable, an allow-list that
 * does not parse or a read that fails gives "unavailable": the chooser then shows no image section
 * (R12, R16). A stored list that was never saved follows the default list, as the panel does.
 */
export async function loadPublicImages(
  regions: readonly string[],
  deps: ImagesDeps = defaultImagesDeps,
): Promise<PublicImages> {
  try {
    return await deps.run(async (tx) => {
      const flags = await deps.flags(tx, PUBLIC_MARKET);
      if (!flags.some((f) => f.key === "linux_instance" && f.enabled)) {
        return { state: "unavailable" } as const;
      }
      const stored = await deps.switches(tx, PUBLIC_MARKET);
      if (stored.state === "invalid") return { state: "unavailable" } as const;
      const list: ImageAllowList = stored.state === "ok" ? stored.switches : EMPTY_ALLOW_LIST;
      const byRegion: Record<string, readonly PublicImage[]> = {};
      for (const region of regions) {
        const rows = await deps.active(tx, region);
        byRegion[region] = offeredImages(rows, list)
          .map((o): PublicImage => ({ id: o.id, name: o.name, version: o.version, kind: o.kind }))
          .sort(byName);
      }
      return { state: "ok", byRegion } as const;
    });
  } catch {
    // Fixed text, no error message in the log (R14).
    writeLog({ event: "public_images_unavailable", severity: "warn", reason: "read" });
    return { state: "unavailable" };
  }
}
