// What pnpm resolved and what it installed, for tests/repo/aws-boundary.test.mjs (rule R1).
//
// readInstalledGraph(root) reads pnpm-lock.yaml and returns the dependency graph of the projects.
// It does not guess what pnpm would do with a dependency value; it reads what pnpm recorded, and
// it stops (throws "installed-graph: ...") at everything these rules do not cover:
//   1. The lockfile: pnpm-lock.yaml exists, is YAML, has lockfileVersion "9.0", and has no
//      top-level key besides lockfileVersion, settings, importers, packages, snapshots, overrides
//      and catalogs (pnpmfileChecksum, patchedDependencies and packageExtensionsChecksum each name
//      a change to what is installed outside the dependency maps; any other key is unknown). Its
//      settings are exactly autoInstallPeers: true and excludeLinksFromLockfile: false.
//   2. The projects: the root (".") and the folders that readWorkspacePackages lists. Each has a
//      package name of the usual form, no two share a name, and the importers of the lockfile are
//      exactly these folders.
//   3. An importer holds only dependencies, devDependencies and optionalDependencies.
//   4. The lockfile belongs to these package.json files. pnpm records each key in one group:
//      optionalDependencies if the key is there, else dependencies, else devDependencies; a key
//      found only in peerDependencies goes to dependencies with the peer value. Each expected key
//      is in its group with the package.json value as specifier, or with the value of an override
//      whose selector ends in that key. The lockfile has no key outside its expected group.
//   5. The resolved name of a dependency: "link:<path>" names the project in that folder (the
//      root, a folder that is no project, or a folder outside the repository stops the reader);
//      "<base>" or "<name>@<base>", where <base> is a version with an optional prerelease and
//      build followed by balanced groups in parentheses, names the registry package <key> or
//      <name>, but only when snapshots has "<name>@<rest>" and packages has "<name>@<base>" with a
//      resolution of integrity alone. Every other form (file:, a URL, git, anything else) stops it.
//   6. Third-party packages: every entry of packages is resolved by integrity alone, and every
//      dependency and optional dependency of every snapshot has a registry form of rule 5.
//   7. The result is { packages, graph }: packages maps a project folder to its name ("." is the
//      root), graph maps a project name to the resolved names of its dependencies.
// No message prints a value of the lockfile (a specifier, a version or a resolution can be a URL
// that holds a token); a message names folders, keys, groups, package names and files only. No
// lookup by a name from the lockfile or a package.json reaches the prototype of an object (a
// folder or a key named "constructor" is only what the file itself holds).
//
// readDirectLinks(root, dir) lists what <dir>/node_modules really holds, because a hoisting
// setting of pnpm changes that and leaves the lockfile as it is.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { parse } from "yaml";
import { readWorkspacePackages } from "./changed-packages.mjs";

const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"];
const TOP_LEVEL = [
  "lockfileVersion",
  "settings",
  "importers",
  "packages",
  "snapshots",
  "overrides",
  "catalogs",
];
const SETTINGS = { autoInstallPeers: true, excludeLinksFromLockfile: false };
const BASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

// The value of `table` under `key` only when `table` holds the key itself: names come from the
// lockfile and from package.json files, and must never reach the prototype of a plain object.
function own(table, key) {
  return table !== null && typeof table === "object" && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

function fail(message) {
  throw new Error(`installed-graph: ${message}`);
}

function readJson(root, path) {
  try {
    return JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch {
    return fail(`${path} cannot be read as JSON`);
  }
}

function workspacePackages(root) {
  try {
    return readWorkspacePackages(root);
  } catch {
    return fail("a package.json under apps/, packages/ or functions/ cannot be read as JSON");
  }
}

// "1.2.3(a@1.0.0)(b@2.0.0(c@3.0.0))" gives "1.2.3" when what follows the version is zero or more
// balanced groups in parentheses; everything else gives null.
function baseOf(version) {
  const open = version.indexOf("(");
  const base = open < 0 ? version : version.slice(0, open);
  if (!BASE.test(base)) return null;
  let depth = 0;
  for (const ch of version.slice(base.length)) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (depth === 0) return null;
  }
  return depth === 0 ? base : null;
}

function resolvedByIntegrity(resolution) {
  return (
    resolution !== null &&
    typeof resolution === "object" &&
    Object.keys(resolution).join() === "integrity" &&
    typeof resolution.integrity === "string"
  );
}

// The name of the registry package that `version` stands for under the key `key`, or null.
// It is a registry package only when the lockfile also holds its snapshot and its package entry,
// and that entry is resolved by integrity alone (no directory, tarball, git reference or type).
function registryName(lock, key, version) {
  if (typeof version !== "string") return null;
  let name = key;
  let rest = version;
  if (!/^\d/.test(version)) {
    const at = version.indexOf("@", 1);
    if (at < 0) return null;
    name = version.slice(0, at);
    rest = version.slice(at + 1);
    if (!NAME.test(name)) return null;
  }
  const base = baseOf(rest);
  if (base === null) return null;
  if (own(lock.snapshots, `${name}@${rest}`) === undefined) return null;
  if (!resolvedByIntegrity(own(own(lock.packages, `${name}@${base}`), "resolution"))) return null;
  return name;
}

function resolvedName(lock, packages, dir, key, version) {
  if (typeof version === "string" && version.startsWith("link:")) {
    const folder = posix.normalize(posix.join(dir, version.slice(5))).replace(/\/+$/, "");
    if (folder !== "." && own(packages, folder) !== undefined) return packages[folder];
    return fail(
      `${dir}: ${key} is linked to a folder that is not a package under apps/, packages/ or functions/`,
    );
  }
  return (
    registryName(lock, key, version) ??
    fail(`${dir}: ${key} is resolved in a form this file does not understand (see pnpm-lock.yaml)`)
  );
}

// The group in which pnpm records a key (pnpm 10.33.3): optionalDependencies before dependencies
// before devDependencies; with autoInstallPeers a peer dependency is recorded in dependencies
// only when no group declares the key.
function expectedGroups(manifest) {
  const out = {
    dependencies: Object.create(null),
    devDependencies: Object.create(null),
    optionalDependencies: Object.create(null),
  };
  for (const [key, value] of Object.entries(manifest.peerDependencies ?? {})) {
    out.dependencies[key] = value;
  }
  for (const group of ["devDependencies", "dependencies", "optionalDependencies"]) {
    for (const [key, value] of Object.entries(manifest[group] ?? {})) {
      for (const other of GROUPS) delete out[other][key];
      out[group][key] = value;
    }
  }
  return out;
}

// An override replaces the specifier that pnpm records for a direct dependency.
function overridden(lock, key, specifier) {
  return Object.entries(lock.overrides ?? {}).some(
    ([selector, value]) =>
      value === specifier &&
      selector
        .split(">")
        .pop()
        .replace(/(?<=.)@.*$/, "") === key,
  );
}

export function readInstalledGraph(root) {
  if (!existsSync(join(root, "pnpm-lock.yaml"))) fail("pnpm-lock.yaml is missing");
  let lock;
  try {
    lock = parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  } catch {
    fail("pnpm-lock.yaml cannot be read as YAML");
  }
  if (lock === null || typeof lock !== "object" || lock.lockfileVersion !== "9.0") {
    fail("pnpm-lock.yaml is not lockfile version 9.0");
  }
  const strangeTop = Object.keys(lock).filter((key) => !TOP_LEVEL.includes(key));
  if (strangeTop.length > 0) {
    fail(
      `pnpm-lock.yaml has the key "${strangeTop.join('", "')}", which this file does not understand`,
    );
  }
  if (
    JSON.stringify(Object.entries(lock.settings ?? {}).sort()) !==
    JSON.stringify(Object.entries(SETTINGS).sort())
  ) {
    fail(
      "the settings of pnpm-lock.yaml are not autoInstallPeers: true and excludeLinksFromLockfile: false",
    );
  }

  const rootManifest = readJson(root, "package.json");
  const packages = { ".": rootManifest.name, ...workspacePackages(root) };
  for (const [dir, name] of Object.entries(packages)) {
    if (typeof name !== "string" || !NAME.test(name)) {
      fail(`${dir === "." ? "package.json" : `${dir}/package.json`} has no valid name`);
    }
  }
  const names = Object.values(packages);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) fail(`two projects share the name ${twice}`);

  const importers = lock.importers ?? {};
  const known = Object.keys(packages).sort();
  const recorded = Object.keys(importers).sort();
  if (JSON.stringify(known) !== JSON.stringify(recorded)) {
    const extra = recorded.filter((dir) => !known.includes(dir));
    const missing = known.filter((dir) => !recorded.includes(dir));
    fail(
      `the projects of pnpm-lock.yaml are not the packages of this repository (only in the lockfile: ${extra.join(", ") || "none"}; only on disk: ${missing.join(", ") || "none"})`,
    );
  }

  const graph = {};
  for (const dir of known) {
    const manifest = dir === "." ? rootManifest : readJson(root, `${dir}/package.json`);
    const importer = own(importers, dir) ?? {};
    const strange = Object.keys(importer).filter((group) => !GROUPS.includes(group));
    if (strange.length > 0) {
      fail(
        `${dir}: pnpm-lock.yaml has "${strange.join('", "')}" for this project, which this file does not understand`,
      );
    }
    const expected = expectedGroups(manifest);
    const targets = [];
    for (const group of GROUPS) {
      const wanted = expected[group];
      const have = own(importer, group) ?? {};
      for (const key of Object.keys(wanted)) {
        const specifier = own(own(have, key), "specifier");
        if (specifier !== wanted[key] && !overridden(lock, key, specifier)) {
          fail(`${dir}: ${key} in ${group} is not what pnpm-lock.yaml records; run pnpm install`);
        }
      }
      for (const [key, entry] of Object.entries(have)) {
        if (!Object.hasOwn(wanted, key)) {
          fail(
            `${dir}: pnpm-lock.yaml records ${key} in ${group}, where package.json does not declare it; run pnpm install`,
          );
        }
        targets.push(resolvedName(lock, packages, dir, key, own(entry, "version")));
      }
    }
    graph[packages[dir]] = targets;
  }

  for (const [id, entry] of Object.entries(lock.packages ?? {})) {
    if (!resolvedByIntegrity(own(entry, "resolution"))) {
      fail(
        `the package ${id} is not resolved from the registry by its checksum alone (see pnpm-lock.yaml)`,
      );
    }
  }
  for (const [id, snapshot] of Object.entries(lock.snapshots ?? {})) {
    for (const group of ["dependencies", "optionalDependencies"]) {
      for (const [key, version] of Object.entries(own(snapshot, group) ?? {})) {
        if (registryName(lock, key, version) === null) {
          fail(
            `the installed package ${id} depends on ${key} in a form this file does not understand (see pnpm-lock.yaml)`,
          );
        }
      }
    }
  }
  return { packages, graph };
}

// What the folder <dir>/node_modules really holds, one entry per name (a scope folder is opened;
// names that start with a dot are pnpm's own). `target` is the real path seen from the root, with
// "/" ("." is the root itself, null a link that leads nowhere); `packageName` is the name in the
// package.json found there, or null.
export function readDirectLinks(root, dir) {
  const folder = join(root, dir, "node_modules");
  if (!existsSync(folder)) return [];
  const realRoot = realpathSync(root);
  const links = [];
  for (const entry of readdirSync(folder).sort()) {
    if (entry.startsWith(".")) continue;
    const names = entry.startsWith("@")
      ? readdirSync(join(folder, entry))
          .sort()
          .map((name) => `${entry}/${name}`)
      : [entry];
    for (const name of names) {
      let target = null;
      let packageName = null;
      try {
        const real = realpathSync(join(folder, name));
        target = relative(realRoot, real).split(sep).join("/") || ".";
        const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
        packageName = typeof manifest.name === "string" ? manifest.name : null;
      } catch {
        // a link that leads nowhere keeps target null; a folder without a readable package.json
        // keeps packageName null
      }
      links.push({ name, target, packageName });
    }
  }
  return links;
}
