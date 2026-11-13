import type { MetadataRoute } from "next";
import { publicOrigin } from "../server/public/load.ts";
import { indexableStage } from "../server/public/indexing.ts";
import { robotsFile } from "../server/public/sitemap.ts";

export const dynamic = "force-dynamic";

/** `/robots.txt`: the public pages are open, the panel, sign-in, API and dev paths are not (WPP-T3). */
export default function robots(): MetadataRoute.Robots {
  // WPU-Z16: staging and every other stage but production disallow everything.
  return robotsFile(publicOrigin(), indexableStage(process.env));
}
