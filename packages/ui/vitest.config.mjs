import { defineProject } from "vitest/config";

// The default environment stays node, so the theme tests run unchanged. A kit test chooses jsdom
// with the docblock line `// @vitest-environment jsdom`.
export default defineProject({
  test: {
    name: "@tc/ui",
    setupFiles: ["./test/setup.ts"],
  },
});
