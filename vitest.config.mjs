import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    allowOnly: false,
    projects: [
      "apps/*",
      "packages/*",
      "functions/*",
      {
        test: {
          name: "repo",
          include: ["tests/repo/**/*.test.mjs", "scripts/**/*.test.mjs"],
        },
      },
    ],
  },
});
