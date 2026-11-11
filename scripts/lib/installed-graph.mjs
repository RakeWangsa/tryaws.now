// What pnpm resolved and what it installed, for tests/repo/aws-boundary.test.mjs (rule R1).
//
// readInstalledGraph(root) reads pnpm-lock.yaml and node_modules/.pnpm/lock.yaml and returns the
// dependency graph of the projects. It does not guess what pnpm would do with a dependency value;
// it reads what pnpm recorded, and it stops (throws "installed-graph: ...") when one of these
// rules does not hold:
//   0. One lockfile and one install: the root holds no pnpm-lock.<anything>.yaml besides
//      pnpm-lock.yaml, and no project folder and no folder between an app and the root holds
//      pnpm-lock.yaml, pnpm-workspace.yaml, node_modules/.pnpm or node_modules/.modules.yaml.
//   1. The lockfile: pnpm-lock.yaml exists and is one YAML document without warnings and without
//      merge keys (<<, which pnpm's parser applies); it has lockfileVersion "9.0"; its top-level
//      keys are among lockfileVersion, settings, importers, packages, snapshots, overrides,
//      catalogs, packageExtensionsChecksum (a sha256- string), ignoredOptionalDependencies (a list
//      of strings) and time (a mapping of strings); its settings are exactly autoInstallPeers:
//      true and excludeLinksFromLockfile: false. patchedDependencies and pnpmfileChecksum stop the
//      reader: a patch or a hook can change what is installed in a way these rules cannot see.
//   2. The projects: the root (".") and the folders that readWorkspacePackages lists. Each has a
//      package name of the usual form, no two share a name, and the importers of the lockfile are
//      exactly these folders.
//   3. An importer holds only dependencies, devDependencies and optionalDependencies.
//   4. Each key of each package.json is recorded in the group where pnpm records it
//      (optionalDependencies before dependencies before devDependencies; a key found only in
//      peerDependencies goes to dependencies with the peer value), with the package.json value as
//      specifier or with the value of an override whose selector has no parent and names that
//      key. The lockfile records no key that package.json does not declare in that group.
//   5. The resolved name of a dependency: "link:<path>" names the project in that folder (the
//      root and a folder that is no project stop the reader); "<base>" or "<name>@<base>", where
//      <base> is a version with an optional prerelease and build followed by balanced groups in
//      parentheses, names the registry package <key> or <name>, but only when snapshots has
//      "<name>@<rest>" and packages has "<name>@<base>" with a resolution of integrity alone.
//      Every other form (file:, a URL, git, anything else) stops the reader.
//   6. Third-party packages: every entry of packages holds only known keys and is resolved by
//      integrity alone; every entry of snapshots holds only known keys, and each of its
//      dependencies and optional dependencies has a registry form of rule 5.
//   7. node_modules/.pnpm/lock.yaml, pnpm's record of the install, exists, passes rules 1 and 6,
//      and has the importers of pnpm-lock.yaml. Its packages and snapshots may hold leftovers of
//      earlier installs, so they are not compared.
// The result is { packages, graph }: packages maps a project folder to its name ("." is the
// root), graph maps a project name to the resolved names of its direct dependencies.
// No message prints a string of a lockfile unless it has passed a form check (a package name, a
// project folder, a group, a key or a setting name); a specifier, a version, a resolution or a
// key of packages can be a URL that holds a token. No lookup by a name from a lockfile or a
// package.json reaches the prototype of an object.
//
// readDirectLinks(root, dir) lists what <dir>/node_modules really holds. boundaryProblems(root,
// sdkNames) puts both together into the four checks of rule R1.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
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
  "packageExtensionsChecksum",
  "ignoredOptionalDependencies",
  "time",
];
const TEACH = ["patchedDependencies", "pnpmfileChecksum"];
const SETTINGS = { autoInstallPeers: true, excludeLinksFromLockfile: false };
const PACKAGE_KEYS = [
  "resolution",
  "engines",
  "os",
  "cpu",
  "libc",
  "hasBin",
  "peerDependencies",
  "peerDependenciesMeta",
  "deprecated",
  "bundledDependencies",
];
const SNAPSHOT_KEYS = [
  "dependencies",
  "optionalDependencies",
  "transitivePeerDependencies",
  "optional",
];
const BASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const FOLDER = /^[A-Za-z0-9._@/-]+$/;
const WORD = /^[A-Za-z][A-Za-z0-9]*$/;
const HIDDEN = "(a name this file does not print)";
// pnpm's border between a parent and a child in an override selector (parsePkgAndParentSelector).
const PARENT_BORDER = /[^ |@]>/;
// A package of pnpm's store, seen from the root.
const STORE_ENTRY = /^node_modules\/\.pnpm\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+$/;
const INSTALLED = "node_modules/.pnpm/lock.yaml";
const INSTALLED_HINT = `(${INSTALLED} is pnpm's record of what is installed: if pnpm-lock.yaml is right, delete node_modules and run pnpm install)`;

// What a message may print: a string that has passed a form check, else a fixed text.
function shown(kind, value) {
  const ok =
    typeof value === "string" &&
    ((kind === "name" && NAME.test(value)) ||
      (kind === "folder" && FOLDER.test(value)) ||
      (kind === "group" && GROUPS.includes(value)) ||
      (kind === "word" && WORD.test(value)));
  return ok ? value : HIDDEN;
}

// What a line may print of a target: a folder of the repository passes the folder check; the
// folder of pnpm's store under node_modules/.pnpm (named after a lockfile key, which can be a URL
// with a token) is replaced by "…"; a folder outside the repository is not printed.
function shownTarget(target) {
  if (target === null) return "null";
  if (target === ".." || target.startsWith("../")) return "(a folder outside the repository)";
  const store = /^node_modules\/\.pnpm\/[^/]+(\/.*)?$/.exec(target);
  if (store) {
    return `node_modules/.pnpm/…${store[1] === undefined ? "" : `/${shown("folder", store[1].slice(1))}`}`;
  }
  return shown("folder", target);
}

// The name part of a key of packages or snapshots ("ms@2.1.3(x@1.0.0)" gives "ms").
function idName(id) {
  const at = id.indexOf("@", 1);
  return shown("name", at < 0 ? id : id.slice(0, at));
}

// The value of `table` under `key` only when `table` holds the key itself.
function own(table, key) {
  return table !== null && typeof table === "object" && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const entriesOf = (value) => Object.entries(isMap(value) ? value : {});

function fail(message) {
  throw new Error(`installed-graph: ${message}`);
}

function readJson(root, path) {
  let value;
  try {
    value = JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch {
    return fail(`${path} cannot be read as JSON`);
  }
  if (!isMap(value)) fail(`${path} does not hold a JSON object`);
  return value;
}

function workspacePackages(root) {
  try {
    return readWorkspacePackages(root);
  } catch {
    return fail("a package.json under apps/, packages/ or functions/ cannot be read as JSON");
  }
}

function hasMergeKey(value) {
  if (Array.isArray(value)) return value.some(hasMergeKey);
  if (!isMap(value)) return false;
  return Object.keys(value).some((key) => key === "<<" || hasMergeKey(value[key]));
}

// Rule 1, the form of the file: one YAML document, no error, no warning, no merge key.
function parseLockfile(root, path) {
  let lock;
  try {
    // logLevel "error": warnings are collected, not printed; a second document is an error
    // (with "silent" the yaml package drops that error).
    const doc = parseDocument(readFileSync(join(root, path), "utf8"), { logLevel: "error" });
    if (doc.errors.length > 0 || doc.warnings.length > 0) throw new Error("not YAML");
    lock = doc.toJS();
  } catch {
    return fail(`${path} cannot be read as YAML`);
  }
  if (hasMergeKey(lock)) {
    fail(`${path} holds a YAML merge key (<<), which pnpm reads and this file does not`);
  }
  return lock;
}

// Rule 1: version, top-level keys, settings.
function checkHead(lock, path) {
  if (!isMap(lock) || lock.lockfileVersion !== "9.0") fail(`${path} is not lockfile version 9.0`);
  for (const key of Object.keys(lock)) {
    if (TEACH.includes(key)) {
      fail(
        `${path} has the key "${key}": read what the patch or the hook changes, then teach scripts/lib/installed-graph.mjs the key`,
      );
    }
    if (!TOP_LEVEL.includes(key)) {
      fail(`${path} has the key "${shown("word", key)}", which this file does not understand`);
    }
  }
  const forms = {
    packageExtensionsChecksum: (v) => typeof v === "string" && v.startsWith("sha256-"),
    ignoredOptionalDependencies: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
    time: (v) => isMap(v) && Object.values(v).every((x) => typeof x === "string"),
  };
  for (const [key, form] of Object.entries(forms)) {
    if (Object.hasOwn(lock, key) && !form(lock[key])) {
      fail(`${path} has a key "${key}" of an unknown form`);
    }
  }
  const settings = isMap(lock.settings) ? lock.settings : {};
  const missing = Object.keys(SETTINGS).filter((key) => !Object.hasOwn(settings, key));
  const unexpected = Object.keys(settings).filter((key) => !Object.hasOwn(SETTINGS, key));
  const other = Object.keys(SETTINGS).filter(
    (key) => Object.hasOwn(settings, key) && settings[key] !== SETTINGS[key],
  );
  if (!isMap(lock.settings) || missing.length + unexpected.length + other.length > 0) {
    const list = (keys) => keys.map((key) => shown("word", key)).join(", ") || "none";
    fail(
      `the settings of ${path} are not autoInstallPeers: true and excludeLinksFromLockfile: false (missing: ${list(missing)}; unexpected: ${list(unexpected)}; another value: ${list(other)})`,
    );
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
    isMap(resolution) &&
    Object.keys(resolution).join() === "integrity" &&
    typeof resolution.integrity === "string"
  );
}

// The name of the registry package that `version` stands for under the key `key`, or null.
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

// Rule 6.
function checkThirdParty(lock, path) {
  for (const [id, entry] of entriesOf(lock.packages)) {
    if (!isMap(entry) || Object.keys(entry).some((key) => !PACKAGE_KEYS.includes(key))) {
      fail(`${path}: the package ${idName(id)} has a key this file does not understand`);
    }
    if (!resolvedByIntegrity(own(entry, "resolution"))) {
      fail(
        `${path}: the package ${idName(id)} is not resolved from the registry by its checksum alone (a tarball URL, a git reference or the setting lockfile-include-tarball-url causes this)`,
      );
    }
  }
  for (const [id, snapshot] of entriesOf(lock.snapshots)) {
    if (!isMap(snapshot) || Object.keys(snapshot).some((key) => !SNAPSHOT_KEYS.includes(key))) {
      fail(`${path}: the installed package ${idName(id)} has a key this file does not understand`);
    }
    for (const group of ["dependencies", "optionalDependencies"]) {
      const deps = own(snapshot, group) ?? {};
      if (!isMap(deps)) {
        fail(`${path}: the installed package ${idName(id)} has a group of an unknown form`);
      }
      for (const [key, version] of Object.entries(deps)) {
        if (registryName(lock, key, version) === null) {
          fail(
            `${path}: the installed package ${idName(id)} depends on ${shown("name", key)} in a form this file does not understand`,
          );
        }
      }
    }
  }
}

function resolvedName(lock, packages, dir, key, version) {
  if (typeof version === "string" && version.startsWith("link:")) {
    const folder = posix.normalize(posix.join(dir, version.slice(5))).replace(/\/+$/, "");
    if (folder !== "." && own(packages, folder) !== undefined) return packages[folder];
    return fail(
      `${shown("folder", dir)}: ${shown("name", key)} is linked to a folder that is not a package under apps/, packages/ or functions/`,
    );
  }
  return (
    registryName(lock, key, version) ??
    fail(
      `${shown("folder", dir)}: ${shown("name", key)} is resolved in a form this file does not understand (see pnpm-lock.yaml)`,
    )
  );
}

// The group in which pnpm records a key (pnpm 10.33.3).
function expectedGroups(manifest) {
  const out = {
    dependencies: Object.create(null),
    devDependencies: Object.create(null),
    optionalDependencies: Object.create(null),
  };
  for (const [key, value] of entriesOf(own(manifest, "peerDependencies"))) {
    out.dependencies[key] = value;
  }
  for (const group of ["devDependencies", "dependencies", "optionalDependencies"]) {
    for (const [key, value] of entriesOf(own(manifest, group))) {
      for (const other of GROUPS) delete out[other][key];
      out[group][key] = value;
    }
  }
  return out;
}

// An override excuses a specifier only when its selector has no parent and names the key.
function overridden(lock, key, specifier) {
  return entriesOf(lock.overrides).some(
    ([selector, value]) =>
      value === specifier &&
      !PARENT_BORDER.test(selector) &&
      selector.replace(/(?<=.)@.*$/, "") === key,
  );
}

// The folders whose node_modules the code of an app or of the root loads from: the root, every
// app, and every folder between an app and the root.
function loadFolders(apps) {
  const dirs = new Set(["."]);
  for (const app of apps) {
    const parts = app.split("/");
    for (let i = 1; i <= parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

// Rule 0.
function checkOneInstall(root, packages) {
  if (readdirSync(root).some((file) => /^pnpm-lock\..+\.yaml$/.test(file))) {
    fail(
      "the root holds a second lockfile besides pnpm-lock.yaml (gitBranchLockfile?): pnpm installs from that one, which this file does not read",
    );
  }
  const apps = Object.keys(packages).filter((dir) => dir.startsWith("apps/"));
  for (const dir of new Set([...Object.keys(packages), ...loadFolders(apps)])) {
    if (dir === ".") continue;
    for (const path of [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "node_modules/.pnpm",
      "node_modules/.modules.yaml",
    ]) {
      if (existsSync(join(root, dir, path))) {
        fail(
          `${shown("folder", dir)} holds ${path}: a second install inside a project, which this file does not read`,
        );
      }
    }
  }
}

// Rule 7: a stop that comes from the installed lockfile says what to do.
function checkInstalled(root, lock) {
  if (!existsSync(join(root, INSTALLED))) fail(`${INSTALLED} is missing: run pnpm install`);
  const withHint = (check) => {
    try {
      return check();
    } catch (error) {
      throw new Error(`${error.message} ${INSTALLED_HINT}`, { cause: error });
    }
  };
  const installed = withHint(() => {
    const parsed = parseLockfile(root, INSTALLED);
    checkHead(parsed, INSTALLED);
    return parsed;
  });
  if (!isDeepStrictEqual(installed.importers, lock.importers)) {
    fail("what is installed in node_modules is not what pnpm-lock.yaml records; run pnpm install");
  }
  withHint(() => checkThirdParty(installed, INSTALLED));
}

export function readInstalledGraph(root) {
  if (!existsSync(join(root, "pnpm-lock.yaml"))) fail("pnpm-lock.yaml is missing");
  const lock = parseLockfile(root, "pnpm-lock.yaml");
  checkHead(lock, "pnpm-lock.yaml");

  const rootManifest = readJson(root, "package.json");
  const packages = { ".": rootManifest.name, ...workspacePackages(root) };
  for (const [dir, name] of Object.entries(packages)) {
    if (typeof name !== "string" || !NAME.test(name)) {
      fail(
        `${dir === "." ? "package.json" : `${shown("folder", dir)}/package.json`} has no valid name`,
      );
    }
  }
  const names = Object.values(packages);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) fail(`two projects share the name ${shown("name", twice)}`);
  checkOneInstall(root, packages);

  const importers = isMap(lock.importers) ? lock.importers : {};
  const known = Object.keys(packages).sort();
  const recorded = Object.keys(importers).sort();
  if (JSON.stringify(known) !== JSON.stringify(recorded)) {
    const list = (dirs) => dirs.map((dir) => shown("folder", dir)).join(", ") || "none";
    fail(
      `the projects of pnpm-lock.yaml are not the packages of this repository (only in the lockfile: ${list(recorded.filter((dir) => !known.includes(dir)))}; only on disk: ${list(known.filter((dir) => !recorded.includes(dir)))}); if a folder is a new place for workspace packages, add it to WORKSPACE_FOLDERS in scripts/lib/changed-packages.mjs`,
    );
  }

  const graph = {};
  for (const dir of known) {
    const where = shown("folder", dir);
    const manifest = dir === "." ? rootManifest : readJson(root, `${dir}/package.json`);
    const importer = own(importers, dir) ?? {};
    if (!isMap(importer)) fail(`${where}: pnpm-lock.yaml has an importer of an unknown form`);
    const strange = Object.keys(importer).filter((group) => !GROUPS.includes(group));
    if (strange.length > 0) {
      fail(
        `${where}: pnpm-lock.yaml has "${strange.map((key) => shown("word", key)).join('", "')}" for this project, which this file does not understand`,
      );
    }
    const expected = expectedGroups(manifest);
    const targets = [];
    for (const group of GROUPS) {
      const wanted = expected[group];
      const have = own(importer, group) ?? {};
      if (!isMap(have)) fail(`${where}: pnpm-lock.yaml has a group of an unknown form`);
      for (const key of Object.keys(wanted)) {
        const specifier = own(own(have, key), "specifier");
        if (specifier !== wanted[key] && !overridden(lock, key, specifier)) {
          fail(
            `${where}: ${shown("name", key)} in ${group} is not what pnpm-lock.yaml records; run pnpm install`,
          );
        }
      }
      for (const [key, entry] of Object.entries(have)) {
        if (!Object.hasOwn(wanted, key)) {
          fail(
            `${where}: pnpm-lock.yaml records ${shown("name", key)} in ${group}, where package.json does not declare it; run pnpm install`,
          );
        }
        targets.push(resolvedName(lock, packages, dir, key, own(entry, "version")));
      }
    }
    graph[packages[dir]] = targets;
  }
  checkThirdParty(lock, "pnpm-lock.yaml");
  checkInstalled(root, lock);
  return { packages, graph };
}

function listFolder(root, path) {
  try {
    return readdirSync(join(root, path)).sort();
  } catch {
    return fail(`${shown("folder", path)} cannot be read as a folder`);
  }
}

// What <dir>/node_modules really holds, one entry per name. A scope folder is opened; a name that
// starts with a dot is skipped only when it is not a symbolic link (pnpm's own files and folders).
// `target` is the real path seen from the root, with "/" ("." is the root itself, null a link that
// leads nowhere); `packageName` is the name in the package.json found there, or null.
export function readDirectLinks(root, dir) {
  const folder = posix.join(dir, "node_modules");
  if (!existsSync(join(root, folder))) return [];
  const realRoot = realpathSync(root);
  const links = [];
  for (const entry of listFolder(root, folder)) {
    if (entry.startsWith(".") && !lstatSync(join(root, folder, entry)).isSymbolicLink()) continue;
    const names = entry.startsWith("@")
      ? listFolder(root, posix.join(folder, entry)).map((name) => `${entry}/${name}`)
      : [entry];
    for (const name of names) {
      let target = null;
      let packageName = null;
      try {
        const real = realpathSync(join(root, folder, name));
        target = relative(realRoot, real).split(sep).join("/") || ".";
        const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
        packageName = typeof manifest?.name === "string" ? manifest.name : null;
      } catch {
        // a link that leads nowhere keeps target null; no readable package.json keeps packageName null
      }
      links.push({ name, target, packageName });
    }
  }
  return links;
}

// The four checks of rule R1, each a list of one readable line per problem:
//   awsUsers: a project outside functions/ (the root included) that depends on packages/aws;
//   sdkUsers: a project other than packages/aws that depends on one of `sdkNames`;
//   reach:    for every app and for the root, each name its declared dependencies reach (through
//             workspace projects) whose folder is packages/aws or under functions/, or that is
//             one of `sdkNames`. A dependency of a third-party package is not followed: only that
//             package can load it by name.
//   installed: each entry of node_modules of the root, of an app or of a folder between, that
//             does not lead to a package of pnpm's store (with a package.json) or to a project
//             that is not the root, packages/aws or a function, or whose name or package name is
//             that of packages/aws, of a function or one of `sdkNames`.
export function boundaryProblems(root, sdkNames) {
  const { packages, graph } = readInstalledGraph(root);
  const awsName = own(packages, "packages/aws");
  const dirOf = new Map(Object.entries(packages).map(([dir, name]) => [name, dir]));
  const isFunction = (name) => dirOf.get(name)?.startsWith("functions/") === true;
  const banned = (name) =>
    name !== null && (name === awsName || isFunction(name) || sdkNames.includes(name));
  const apps = Object.keys(packages).filter((dir) => dir.startsWith("apps/"));

  const awsUsers = [];
  const sdkUsers = [];
  for (const [dir, name] of Object.entries(packages)) {
    const deps = own(graph, name) ?? [];
    if (awsName !== undefined && !dir.startsWith("functions/") && deps.includes(awsName)) {
      awsUsers.push(`${shown("folder", dir)} depends on ${awsName}`);
    }
    if (dir !== "packages/aws") {
      for (const sdk of sdkNames.filter((s) => deps.includes(s))) {
        sdkUsers.push(`${shown("folder", dir)} depends on ${sdk}`);
      }
    }
  }

  const reach = [];
  for (const dir of [...apps, "."]) {
    const seen = new Set();
    const todo = [packages[dir]];
    while (todo.length > 0) {
      for (const d of own(graph, todo.pop()) ?? []) {
        if (!seen.has(d)) {
          seen.add(d);
          todo.push(d);
        }
      }
    }
    for (const d of [...seen].sort()) {
      if (dirOf.get(d) === "packages/aws" || isFunction(d) || sdkNames.includes(d)) {
        reach.push(`${shown("folder", dir)} reaches ${d}`);
      }
    }
  }

  const allowed = ({ name, target, packageName }) => {
    if (banned(name) || banned(packageName) || target === null) return false;
    if (STORE_ENTRY.test(target)) return packageName !== null;
    return (
      target !== "." &&
      Object.hasOwn(packages, target) &&
      target !== "packages/aws" &&
      !target.startsWith("functions/")
    );
  };
  const installed = [];
  for (const dir of loadFolders(apps)) {
    for (const link of readDirectLinks(root, dir)) {
      if (!allowed(link)) {
        installed.push(
          `${shown("folder", dir)}: ${shown("name", link.name)} -> ${shownTarget(link.target)}`,
        );
      }
    }
  }
  return { awsUsers, sdkUsers, reach, installed };
}
