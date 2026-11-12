import { headers } from "next/headers";
import { cache } from "react";
import { readWebConfig } from "../config.ts";
import { loadPublicCatalog } from "./catalog.ts";
import type { PublicCatalog } from "./catalog.ts";

// What every public page reads, once per request (`cache`): the catalog with its prices and flags,
// the plain origin for canonical URLs, and the nonce of the request for the JSON-LD blocks (U4).

export const publicCatalog = cache((): Promise<PublicCatalog> =>
  loadPublicCatalog(() => new Date()),
);

/** The origin of the site (APP_ORIGIN). A missing or malformed value throws: no canonical URL is guessed (R16). */
export function publicOrigin(): string {
  return readWebConfig(process.env).appOrigin;
}

/** The nonce the proxy made for this request; undefined when there is none (tests, static output). */
export async function requestNonce(): Promise<string | undefined> {
  return (await headers()).get("x-nonce") ?? undefined;
}
