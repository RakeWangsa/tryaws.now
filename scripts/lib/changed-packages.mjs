// Maps changed files to workspace packages for `pnpm verify --quick`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_FOLDERS = ["apps", "packages", "functions"];

// Folder -> package name for every workspace package, for example "packages/core" -> "@tc/core".
export function readWorkspacePackages(root) {
  const packages = {};
  for (const parent of WORKSPACE_FOLDERS) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      const manifest = join(parentDir, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      packages[`${parent}/${entry.name}`] = JSON.parse(readFileSync(manifest, "utf8")).name;
    }
  }
  return packages;
}

// The package names touched by `files`, or "all" when a file lies outside every package or when
// nothing changed (then the whole repository is checked).
export function changedPackages(files, packages) {
  if (files.length === 0) return "all";
  const names = [];
  for (const file of files) {
    const folder = Object.keys(packages).find((dir) => file.startsWith(`${dir}/`));
    if (folder === undefined) return "all";
    if (!names.includes(packages[folder])) names.push(packages[folder]);
  }
  return names;
}
