// Is the Antler theme in this checkout? (WPU-X30a, docs/theme.md)
//
// The theme is a paid third-party product (Envato "Antler") and is not part of the public repository.
// A public checkout has neither design/mockup/ (the licensed original) nor packages/ui/theme/assets/
// (the vendored copy that `pnpm theme:sync` writes from it). The code, the unit tests and the build
// still work there; only what needs the theme itself is skipped, and each skip says why.
//
// This is the one place that answers the question. Tests gate on it with `describe.skipIf` or
// `it.skipIf` (the apps import it as `@tc/ui/theme-present`). It uses Node only and no browser code
// imports it. scripts/sync-theme.ts does not use it: it asks the same question of the `repoRoot` that
// its caller gives, so that its tests can run on a small repository in a temporary folder.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDORED_ASSETS } from "./manifest.ts";

/** The licensed original, relative to the repository root. Its absence is the normal public state. */
export const MOCKUP_TEMPLATE = "design/mockup/template";

/** The root of this repository: packages/ui/theme/ is three levels below it. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** design/mockup/template exists: the theme can be imported and the mockup pages can be read. */
export function mockupPresent(root: string = REPO_ROOT): boolean {
  return existsSync(join(root, MOCKUP_TEMPLATE));
}

/** packages/ui/theme/assets exists: the vendored copy of the theme's CSS, fonts and images. */
export function vendoredThemePresent(root: string = REPO_ROOT): boolean {
  return existsSync(join(root, VENDORED_ASSETS));
}

/** Both exist, which is the state of a checkout whose owner holds an Antler licence. */
export function antlerThemePresent(root: string = REPO_ROOT): boolean {
  return mockupPresent(root) && vendoredThemePresent(root);
}

/** Why a suite is skipped; put it in the name of the suite or in a skip note. */
export const THEME_ABSENT =
  "the Antler theme is not in this checkout (bring your own: docs/theme.md)";
