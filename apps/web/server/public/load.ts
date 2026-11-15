import { headers } from "next/headers";
import { cache } from "react";
import { readWebConfig } from "../config.ts";
import { loadPublicCatalog } from "./catalog.ts";
import type { PublicCatalog } from "./catalog.ts";
import { PUBLIC_IMAGE_REGIONS, loadPublicImages } from "./images.ts";
import type { PublicImages } from "./images.ts";

// What every public page reads, once per request (`cache`): the catalog with its prices and flags,
// the plain origin for canonical URLs, and the nonce of the request for the JSON-LD blocks (U4).

export const publicCatalog = cache((): Promise<PublicCatalog> =>
  loadPublicCatalog(() => new Date()),
);

// WPU-X22: the offered images of the two public locations (the home chooser).
export const publicImages = cache((): Promise<PublicImages> =>
  loadPublicImages(PUBLIC_IMAGE_REGIONS),
);

/**
 * The origin of the site (APP_ORIGIN), or null when the configuration is missing or malformed. A page
 * then has no canonical URL, no hreflang and no structured data: nothing is guessed (R16), and the
 * page itself still works.
 */
export function publicOrigin(): string | null {
  try {
    return readWebConfig(process.env).appOrigin;
  } catch {
    return null;
  }
}

/** The nonce the proxy made for this request; undefined when there is none (tests, static output). */
export async function requestNonce(): Promise<string | undefined> {
  return (await headers()).get("x-nonce") ?? undefined;
}
