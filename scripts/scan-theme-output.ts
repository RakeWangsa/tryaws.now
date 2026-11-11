// pnpm theme:scan <folder>...   (spec 16.16: the build output has no file from the theme's assets/js)
import { fileURLToPath } from "node:url";
import { scanThemeOutputMain } from "../packages/ui/theme/scan-output.ts";

process.exitCode = scanThemeOutputMain(process.argv.slice(2), {
  cwd: process.cwd(),
  hashFile: fileURLToPath(new URL("../packages/ui/theme/script-hashes.txt", import.meta.url)),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
