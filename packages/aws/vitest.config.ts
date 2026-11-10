import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "@tc/aws", setupFiles: ["./test/setup.ts"] },
});
