import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // next-intl/middleware imports "next/server" without the extension, which plain Node ESM
    // refuses. Vite resolves it when the package is inlined (needed by proxy.test.ts).
    server: { deps: { inline: ["next-intl"] } },
  },
});
