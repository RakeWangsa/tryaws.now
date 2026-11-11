import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @tc/ui is raw TypeScript with explicit .ts import extensions.
  transpilePackages: ["@tc/ui"],
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};

export default withNextIntl(nextConfig);
