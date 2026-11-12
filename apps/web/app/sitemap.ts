import type { MetadataRoute } from "next";
import { publicCatalog, publicOrigin } from "../server/public/load.ts";
import { sitemapEntries } from "../server/public/sitemap.ts";

// Read for every request, like every route of the app: the families that are open change with the
// flags, and the smoke test of the build expects no static route (scripts/smoke-apps.mjs).
export const dynamic = "force-dynamic";

/** `/sitemap.xml`: the public pages in bn and en with their `hreflang` alternates (WPP-T3). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(publicOrigin(), await publicCatalog());
}
