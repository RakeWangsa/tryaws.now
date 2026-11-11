import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { readWebConfig } from "./server/config.ts";
import { NEXT_PREFIXES } from "./server/request.ts";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Server Actions accept an Origin that differs from the host the server sees (CloudFront in front
// of the function) only for the host of our own origin. VERIFY (next docs, serverActions.md): the
// key is `experimental.serverActions.allowedOrigins`, entries are hosts (with the port when there
// is one), not origins. When the environment does not parse (a build without TC_STAGE and
// APP_ORIGIN), the list is empty and only the same origin is allowed: the safe default. The
// runtime itself refuses to start on a bad configuration (server/runtime.ts).
function allowedActionHosts(): string[] {
  try {
    return [new URL(readWebConfig(process.env).appOrigin).host];
  } catch {
    return [];
  }
}

// The signed-in panel is never indexed (16.7). The paths are those of NEXT_PREFIXES, in both locales;
// `/pay/...` and the dev pages are noindex through their own handlers and metadata.
export const PANEL_NOINDEX_SOURCES: readonly string[] = NEXT_PREFIXES.flatMap((prefix) => [
  `${prefix}/:path*`,
  `/en${prefix}/:path*`,
]);

const nextConfig: NextConfig = {
  async headers() {
    return PANEL_NOINDEX_SOURCES.map((source) => ({
      source,
      headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
    }));
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // @tc/ui is raw TypeScript with explicit .ts import extensions.
  transpilePackages: ["@tc/ui"],
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  experimental: { serverActions: { allowedOrigins: allowedActionHosts() } },
};

export default withNextIntl(nextConfig);
