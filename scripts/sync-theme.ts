// pnpm theme:sync --stage import [--check]   (spec 16.3). All logic is in packages/ui/theme.
import { fileURLToPath } from "node:url";
import { syncThemeMain } from "../packages/ui/theme/sync-main.ts";

process.exitCode = syncThemeMain(process.argv.slice(2), {
  repoRoot: fileURLToPath(new URL("..", import.meta.url)),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
