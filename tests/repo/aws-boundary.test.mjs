import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { awsSdkClients } from "../../eslint.config.mjs";
import { readDirectLinks, readInstalledGraph } from "../../scripts/lib/installed-graph.mjs";

// R1: the web app and the admin app never import packages/aws, and only packages/aws depends on
// the six AWS packages of section 4. Three things are meant to keep that:
//   1. IAM: the roles of the apps get no permission to assume a pool role. That is the boundary.
//      It is built and proven in WP0-T5, not here, and it does not exist yet.
//   2. The lint rule on import statements (eslint.config.mjs).
//   3. This file. It catches accidents and makes a deliberate route visible in review. It is not
//      the boundary.
// This file does not guess what pnpm will do with a dependency value. It reads what pnpm did:
//   - pnpm-lock.yaml (scripts/lib/installed-graph.mjs): the package that every dependency of
//     every project resolved to. The reader checks first that the lockfile is the lockfile of
//     these package.json files, and it stops at everything it does not understand.
//   - the installed tree: what node_modules of the root and of each app hold, because a hoisting
//     setting of pnpm changes that and leaves the lockfile as it is.
// What this file cannot see: a package of the registry that holds a copy of this code under
// another name; a lockfile edited by hand in a way the rules of the reader do not check; what a
// bundler setting or a tsconfig path pulls in; an import of a path that is computed at run time;
// the folder node_modules/.pnpm/node_modules, into which pnpm links every workspace package by
// default and from which only installed third-party packages load.

// Part 1: the repository itself.
const SDK = awsSdkClients;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { packages, graph } = readInstalledGraph(ROOT);
// Names and folders come from the lockfile and from package.json files: no lookup may reach the
// prototype of a plain object (a package named "constructor" would find a function there).
const dirOf = new Map(Object.entries(packages).map(([dir, name]) => [name, dir]));
const isProject = (dir) => Object.hasOwn(packages, dir);
const apps = Object.keys(packages).filter((dir) => dir.startsWith("apps/"));
const isFunction = (name) => dirOf.get(name)?.startsWith("functions/") === true;

function reachable(edges, start) {
  const seen = new Set();
  const todo = [start];
  while (todo.length) {
    const next = todo.pop();
    for (const d of Object.hasOwn(edges, next) ? edges[next] : []) {
      if (!seen.has(d)) {
        seen.add(d);
        todo.push(d);
      }
    }
  }
  return seen;
}

it("the walk finds a dependency two steps away", () => {
  expect([...reachable({ a: ["b"], b: ["@tc/aws"] }, "a")].sort()).toEqual(["@tc/aws", "b"]);
});

it("the walk does not follow a name of Object.prototype", () => {
  expect([...reachable({ a: ["constructor"] }, "a")]).toEqual(["constructor"]);
});

// An entry of node_modules is allowed when neither its name nor the name in its package.json is
// the name of packages/aws, of a function or of an AWS package of section 4, and it leads either
// to an installed third-party package or to a project that is not the root, not packages/aws and
// not under functions/.
const banned = (name) =>
  name !== null && (name === packages["packages/aws"] || isFunction(name) || SDK.includes(name));
function linkAllowed({ name, target, packageName }) {
  if (banned(name) || banned(packageName) || target === null) return false;
  if (target.split("/").includes("node_modules")) return true;
  return (
    target !== "." &&
    isProject(target) &&
    target !== "packages/aws" &&
    !target.startsWith("functions/")
  );
}

it.each([
  [{ name: "ms", target: "node_modules/.pnpm/ms@2.1.3/node_modules/ms", packageName: "ms" }, true],
  [{ name: "@tc/core", target: "packages/core", packageName: "@tc/core" }, true],
  [{ name: "x", target: "constructor", packageName: null }, false],
  [{ name: "x", target: "packages/aws", packageName: "@tc/aws" }, false],
  [{ name: "x", target: ".", packageName: "ticoncloud-platform" }, false],
  [{ name: "x", target: null, packageName: null }, false],
  [{ name: "constructor", target: "node_modules/x", packageName: "constructor" }, true],
])("the link check on the entry %j gives %s", (entry, allowed) => {
  expect(linkAllowed(entry)).toBe(allowed);
});

it("the banned AWS packages are the six of the lint config", () => {
  expect([...awsSdkClients].sort()).toEqual([
    "@aws-sdk/client-cost-explorer",
    "@aws-sdk/client-lightsail",
    "@aws-sdk/client-route-53",
    "@aws-sdk/client-route-53-domains",
    "@aws-sdk/client-sts",
    "@aws-sdk/credential-providers",
  ]);
});

it("only a project under functions/ depends on packages/aws (R1)", () => {
  expect(packages["packages/aws"]).toBeDefined();
  const offenders = Object.entries(packages)
    .filter(
      ([dir, name]) =>
        graph[name].includes(packages["packages/aws"]) && !dir.startsWith("functions/"),
    )
    .map(([dir]) => dir);
  expect(offenders).toEqual([]);
});

it("only packages/aws depends on the AWS packages of section 4", () => {
  expect(graph[packages["packages/aws"]].some((d) => SDK.includes(d))).toBe(true);
  const offenders = Object.entries(packages)
    .filter(([dir, name]) => dir !== "packages/aws" && graph[name].some((d) => SDK.includes(d)))
    .map(([dir]) => dir);
  expect(offenders).toEqual([]);
});

it("an app cannot reach packages/aws, a function or an AWS package of section 4 through what is declared (R1)", () => {
  expect(apps).toContain("apps/web");
  expect(apps).toContain("apps/admin");
  // The root is walked too: Node resolves upward, so what the root declares can be imported from
  // an app that does not declare it.
  for (const dir of [...apps, "."]) {
    const found = [...reachable(graph, packages[dir])].filter(
      (d) => dirOf.get(d) === "packages/aws" || isFunction(d) || SDK.includes(d),
    );
    expect({ dir, found }).toEqual({ dir, found: [] });
  }
});

// When this fails: a hoisting setting of pnpm (shamefullyHoist, publicHoistPattern), a dependency
// of the root package, or a link made by hand lets an app import the package without declaring it.
it("nothing in node_modules of the root or of an app leads to packages/aws, a function or an AWS package of section 4 (R1)", () => {
  expect(readDirectLinks(ROOT, ".").map((link) => link.name)).toContain("vitest");
  const notAllowed = [];
  for (const dir of [".", ...apps]) {
    for (const link of readDirectLinks(ROOT, dir)) {
      if (!linkAllowed(link)) notAllowed.push(`${dir}: ${link.name} -> ${link.target}`);
    }
  }
  expect(notAllowed).toEqual([]);
});

// Part 2 and Part 3 write small workspaces into a temporary folder.
const TMP = mkdtempSync(join(tmpdir(), "tc-graph-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let workspaces = 0;

// Writes a workspace: `manifests` maps a project folder ("." is the root) to its package.json
// (an object, or a string written as it is); `lock` is the text of pnpm-lock.yaml (none if null).
function workspace(manifests, lock) {
  workspaces += 1;
  const root = join(TMP, `ws${workspaces}`);
  const files = Object.fromEntries(
    Object.entries(manifests).map(([dir, manifest]) => [
      dir === "." ? "package.json" : `${dir}/package.json`,
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    ]),
  );
  if (lock !== null) files["pnpm-lock.yaml"] = lock;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const HEAD = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
`;
const ROOT_PKG = { name: "ticoncloud-platform" };
const WEB = { name: "@tc/web" };
// The checksum is not checked by the reader; every fixture uses this one of ms@2.1.3.
const SUM =
  "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==";
const MS_ONLY = `
packages:

  ms@2.1.3:
    resolution: {integrity: ${SUM}}

snapshots:

  ms@2.1.3: {}
`;
const webDepends = (deps, lockDeps, rest = MS_ONLY) =>
  workspace(
    { ".": ROOT_PKG, "apps/web": { ...WEB, dependencies: deps } },
    `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
${lockDeps}
${rest}`,
  );

describe("readInstalledGraph gives the graph that pnpm resolved", () => {
  it("G1: workspace:* resolves to the linked project", () => {
    const root = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": { ...WEB, dependencies: { "@tc/core": "workspace:*" } },
        "packages/core": { name: "@tc/core" },
      },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      '@tc/core':
        specifier: workspace:*
        version: link:../../packages/core

  packages/core: {}
`,
    );
    expect(readInstalledGraph(root)).toEqual({
      packages: { ".": "ticoncloud-platform", "apps/web": "@tc/web", "packages/core": "@tc/core" },
      graph: { "ticoncloud-platform": [], "@tc/web": ["@tc/core"], "@tc/core": [] },
    });
  });

  it("G2: a bare path gives the name of the linked project, not the key", () => {
    const root = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": { ...WEB, dependencies: { x: "../../packages/aws" } },
        "packages/aws": { name: "@tc/aws" },
      },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      x:
        specifier: ../../packages/aws
        version: link:../../packages/aws

  packages/aws: {}
`,
    );
    expect(readInstalledGraph(root).graph["@tc/web"]).toEqual(["@tc/aws"]);
  });

  it("G3: an unscoped workspace alias gives the name of the function it links", () => {
    const root = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": { ...WEB, dependencies: { x: "workspace:legacy-reader@*" } },
        "functions/legacy": { name: "legacy-reader" },
      },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      x:
        specifier: workspace:legacy-reader@*
        version: link:../../functions/legacy

  functions/legacy: {}
`,
    );
    expect(readInstalledGraph(root).graph["@tc/web"]).toEqual(["legacy-reader"]);
  });

  it("G4: a dependency of the root is linked from the folder of the root", () => {
    const root = workspace(
      {
        ".": { ...ROOT_PKG, devDependencies: { "@tc/aws": "workspace:*" } },
        "packages/aws": { name: "@tc/aws" },
      },
      `${HEAD}
importers:

  .:
    devDependencies:
      '@tc/aws':
        specifier: workspace:*
        version: link:packages/aws

  packages/aws: {}
`,
    );
    expect(readInstalledGraph(root).graph["ticoncloud-platform"]).toEqual(["@tc/aws"]);
  });

  it("G5: a registry version gives the key, an alias gives the name of the package", () => {
    const root = webDepends(
      { ms: "2.1.3", sv: "npm:semver@7.8.6" },
      `      ms:
        specifier: 2.1.3
        version: 2.1.3
      sv:
        specifier: npm:semver@7.8.6
        version: semver@7.8.6`,
      `
packages:

  ms@2.1.3:
    resolution: {integrity: ${SUM}}

  semver@7.8.6:
    resolution: {integrity: ${SUM}}
    engines: {node: '>=10'}
    hasBin: true

snapshots:

  ms@2.1.3: {}

  semver@7.8.6: {}
`,
    );
    expect(readInstalledGraph(root).graph["@tc/web"]).toEqual(["ms", "semver"]);
  });

  it("G6: a version with a peer suffix, and one with nested parentheses", () => {
    const root = webDepends(
      { next: "16.0.0-canary.1", "react-dom": "19.1.0", react: "19.1.0" },
      `      next:
        specifier: 16.0.0-canary.1
        version: 16.0.0-canary.1(react-dom@19.1.0(react@19.1.0))(react@19.1.0)
      react:
        specifier: 19.1.0
        version: 19.1.0
      react-dom:
        specifier: 19.1.0
        version: 19.1.0(react@19.1.0)`,
      `
packages:

  next@16.0.0-canary.1:
    resolution: {integrity: ${SUM}}
    peerDependencies:
      react: ^18.2.0 || ^19.0.0
      react-dom: ^18.2.0 || ^19.0.0

  react-dom@19.1.0:
    resolution: {integrity: ${SUM}}
    peerDependencies:
      react: ^19.1.0

  react@19.1.0:
    resolution: {integrity: ${SUM}}

  scheduler@0.26.0:
    resolution: {integrity: ${SUM}}

snapshots:

  next@16.0.0-canary.1(react-dom@19.1.0(react@19.1.0))(react@19.1.0):
    dependencies:
      react: 19.1.0
      react-dom: 19.1.0(react@19.1.0)

  react-dom@19.1.0(react@19.1.0):
    dependencies:
      react: 19.1.0
      scheduler: 0.26.0

  react@19.1.0: {}

  scheduler@0.26.0: {}
`,
    );
    expect(readInstalledGraph(root).graph["@tc/web"]).toEqual(["next", "react", "react-dom"]);
  });

  const coreWith = (manifest, importer, rest = MS_ONLY, top = "") =>
    workspace(
      { ".": ROOT_PKG, "packages/core": { name: "@tc/core", ...manifest } },
      `${HEAD}${top}
importers:

  .: {}

  packages/core:
${importer}
${rest}`,
    );

  it("G7: a key in dependencies and devDependencies is recorded under dependencies only", () => {
    const root = coreWith(
      { dependencies: { ms: "2.1.3" }, devDependencies: { ms: "2.1.3" } },
      `    dependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3`,
    );
    expect(readInstalledGraph(root).graph["@tc/core"]).toEqual(["ms"]);
  });

  it("G8: a key in dependencies and optionalDependencies is recorded under optionalDependencies only", () => {
    const root = coreWith(
      { dependencies: { ms: "2.1.3" }, optionalDependencies: { ms: "2.1.3" } },
      `    optionalDependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3`,
      `
packages:

  ms@2.1.3:
    resolution: {integrity: ${SUM}}

snapshots:

  ms@2.1.3:
    optional: true
`,
    );
    expect(readInstalledGraph(root).graph["@tc/core"]).toEqual(["ms"]);
  });

  it("G9: a key only in peerDependencies is recorded under dependencies with the peer value", () => {
    const root = coreWith(
      { peerDependencies: { ms: "^2.1.0" } },
      `    dependencies:
      ms:
        specifier: ^2.1.0
        version: 2.1.3`,
    );
    expect(readInstalledGraph(root).graph["@tc/core"]).toEqual(["ms"]);
  });

  it("G10: an override that pins a direct dependency replaces its specifier", () => {
    const root = coreWith(
      { dependencies: { ms: "^2.0.0" } },
      `    dependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3`,
      MS_ONLY,
      `
overrides:
  ms: 2.1.3
`,
    );
    expect(readInstalledGraph(root).graph["@tc/core"]).toEqual(["ms"]);
  });

  it("G11: catalog: with the catalogs of the lockfile", () => {
    const root = coreWith(
      { dependencies: { ms: "catalog:" } },
      `    dependencies:
      ms:
        specifier: 'catalog:'
        version: 2.1.3`,
      MS_ONLY,
      `
catalogs:
  default:
    ms:
      specifier: 2.1.3
      version: 2.1.3
`,
    );
    expect(readInstalledGraph(root).graph["@tc/core"]).toEqual(["ms"]);
  });

  it("G12: a lockfile without third-party packages has no packages and no snapshots", () => {
    const root = workspace(
      {
        ".": ROOT_PKG,
        "packages/aws": { name: "@tc/aws" },
        "functions/reader": { name: "@tc/fn-reader", dependencies: { "@tc/aws": "workspace:*" } },
      },
      `${HEAD}
importers:

  .: {}

  functions/reader:
    dependencies:
      '@tc/aws':
        specifier: workspace:*
        version: link:../../packages/aws

  packages/aws: {}
`,
    );
    expect(readInstalledGraph(root).graph).toEqual({
      "ticoncloud-platform": [],
      "@tc/fn-reader": ["@tc/aws"],
      "@tc/aws": [],
    });
  });
});

describe("readInstalledGraph stops at what it does not understand", () => {
  const msLock = (top = "") => `${HEAD}${top}
importers:

  .: {}

  apps/web:
    dependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3
${MS_ONLY}`;
  const msWeb = (lock) =>
    workspace({ ".": ROOT_PKG, "apps/web": { ...WEB, dependencies: { ms: "2.1.3" } } }, lock);

  it("the honest form of these stop rows passes", () => {
    expect(readInstalledGraph(msWeb(msLock())).graph["@tc/web"]).toEqual(["ms"]);
  });

  it("S1: no lockfile, a lockfile that is not YAML, a lockfile of another version", () => {
    expect(() => readInstalledGraph(msWeb(null))).toThrow(
      /^installed-graph: pnpm-lock\.yaml is missing$/,
    );
    expect(() => readInstalledGraph(msWeb("lockfileVersion: [\n"))).toThrow(
      /pnpm-lock\.yaml cannot be read as YAML/,
    );
    expect(() =>
      readInstalledGraph(
        msWeb(msLock().replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'")),
      ),
    ).toThrow(/pnpm-lock\.yaml is not lockfile version 9\.0/);
  });

  it.each([
    [
      "pnpmfileChecksum",
      "\npnpmfileChecksum: sha256-8c9KmV0nkci08FyUjvW1jv3MLN9AWoYA3aRKGMkDcZc=\n",
    ],
    [
      "patchedDependencies",
      "\npatchedDependencies:\n  ms@2.1.3:\n    hash: 7962a522d9b80d07dae3a7cbff1bc47837a795f4fb9a738d756f090640c58d95\n    path: patches/ms@2.1.3.patch\n",
    ],
    [
      "packageExtensionsChecksum",
      "\npackageExtensionsChecksum: sha256-h691be5C9QH26488dz6KPVotM8orA9uPKoH82Cil878=\n",
    ],
    ["futureKey", "\nfutureKey: true\n"],
  ])("S2: the top-level key %s stops the reader", (key, top) => {
    expect(() => readInstalledGraph(msWeb(msLock(top)))).toThrow(
      new RegExp(`pnpm-lock\\.yaml has the key "${key}", which this file does not understand`),
    );
  });

  it.each([
    [
      "excludeLinksFromLockfile: true",
      (lock) => lock.replace("excludeLinksFromLockfile: false", "excludeLinksFromLockfile: true"),
    ],
    [
      "autoInstallPeers: false",
      (lock) => lock.replace("autoInstallPeers: true", "autoInstallPeers: false"),
    ],
    [
      "a third setting",
      (lock) =>
        lock.replace(
          "excludeLinksFromLockfile: false",
          "excludeLinksFromLockfile: false\n  injectWorkspacePackages: true",
        ),
    ],
  ])("S3: the settings stop the reader: %s", (_, change) => {
    expect(() => readInstalledGraph(msWeb(change(msLock())))).toThrow(
      /the settings of pnpm-lock\.yaml are not autoInstallPeers: true and excludeLinksFromLockfile: false/,
    );
  });

  it("S4: an importer that is no project on disk, a project on disk with no importer", () => {
    const bridge = workspace(
      { ".": ROOT_PKG, "apps/web": { ...WEB, dependencies: { "@tc/bridge": "workspace:*" } } },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      '@tc/bridge':
        specifier: workspace:*
        version: link:../../tools/bridge

  tools/bridge: {}
`,
    );
    expect(() => readInstalledGraph(bridge)).toThrow(
      /only in the lockfile: tools\/bridge; only on disk: none/,
    );
    const onlyRoot = workspace(
      { ".": ROOT_PKG, "apps/web": WEB },
      `${HEAD}\nimporters:\n\n  .: {}\n`,
    );
    expect(() => readInstalledGraph(onlyRoot)).toThrow(
      /only in the lockfile: none; only on disk: apps\/web/,
    );
  });

  it("S5: a project without a name, two projects with the same name", () => {
    const anon = workspace(
      { ".": ROOT_PKG, "apps/web": WEB, "packages/anon": { version: "1.0.0" } },
      `${HEAD}\nimporters:\n\n  .: {}\n\n  apps/web: {}\n\n  packages/anon: {}\n`,
    );
    expect(() => readInstalledGraph(anon)).toThrow(
      /packages\/anon\/package\.json has no valid name/,
    );
    const twice = workspace(
      { ".": ROOT_PKG, "apps/web": WEB, "packages/zz": { name: "@tc/web", version: "0.0.1" } },
      `${HEAD}\nimporters:\n\n  .: {}\n\n  apps/web: {}\n\n  packages/zz: {}\n`,
    );
    expect(() => readInstalledGraph(twice)).toThrow(/two projects share the name @tc\/web/);
  });

  it("S6: an importer with dependenciesMeta, an importer with publishDirectory", () => {
    const meta = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": {
          ...WEB,
          dependencies: { "@tc/aws": "workspace:*" },
          dependenciesMeta: { "@tc/aws": { injected: true } },
        },
        "packages/aws": { name: "@tc/aws" },
      },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      '@tc/aws':
        specifier: workspace:*
        version: file:packages/aws
    dependenciesMeta:
      '@tc/aws':
        injected: true

  packages/aws: {}
`,
    );
    expect(() => readInstalledGraph(meta)).toThrow(
      /apps\/web: pnpm-lock\.yaml has "dependenciesMeta" for this project/,
    );
    const publish = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": { ...WEB, dependencies: { "@tc/core": "workspace:*" } },
        "packages/aws": { name: "@tc/aws" },
        "packages/core": {
          name: "@tc/core",
          publishConfig: { directory: "../aws", linkDirectory: true },
        },
      },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      '@tc/core':
        specifier: workspace:*
        version: link:../../packages/aws

  packages/aws: {}

  packages/core:
    publishDirectory: ../aws
`,
    );
    expect(() => readInstalledGraph(publish)).toThrow(
      /packages\/core: pnpm-lock\.yaml has "publishDirectory" for this project/,
    );
  });

  it("S7: the lockfile is not the lockfile of these package.json files", () => {
    const record = (group, specifier) =>
      `  ${group}:\n      ms:\n        specifier: ${specifier}\n        version: 2.1.3`;
    const lockWith = (importer) => `${HEAD}
importers:

  .: {}

  apps/web:
  ${importer}
${MS_ONLY}`;
    const web = (manifest, importer) =>
      workspace({ ".": ROOT_PKG, "apps/web": { ...WEB, ...manifest } }, lockWith(importer));
    const differs = web({ dependencies: { ms: "^2.1.0" } }, record("dependencies", "2.1.3"));
    expect(() => readInstalledGraph(differs)).toThrow(
      /apps\/web: ms in dependencies is not what pnpm-lock\.yaml records; run pnpm install/,
    );
    const lacks = workspace(
      { ".": ROOT_PKG, "apps/web": { ...WEB, dependencies: { ms: "2.1.3" } } },
      `${HEAD}\nimporters:\n\n  .: {}\n\n  apps/web: {}\n`,
    );
    expect(() => readInstalledGraph(lacks)).toThrow(
      /apps\/web: ms in dependencies is not what pnpm-lock\.yaml records/,
    );
    const extra = web({}, record("dependencies", "2.1.3"));
    expect(() => readInstalledGraph(extra)).toThrow(
      /apps\/web: pnpm-lock\.yaml records ms in dependencies, where package\.json does not declare it/,
    );
    const otherGroup = web({ dependencies: { ms: "2.1.3" } }, record("devDependencies", "2.1.3"));
    expect(() => readInstalledGraph(otherGroup)).toThrow(
      /apps\/web: ms in dependencies is not what pnpm-lock\.yaml records/,
    );
  });

  it("S7: a key of the lockfile named like a property of Object.prototype is still reported", () => {
    const root = workspace(
      { ".": ROOT_PKG, "apps/web": WEB },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      constructor:
        specifier: 1.0.0
        version: 1.0.0
`,
    );
    expect(() => readInstalledGraph(root)).toThrow(
      /apps\/web: pnpm-lock\.yaml records constructor in dependencies, where package\.json does not declare it/,
    );
  });

  it.each([
    ["to the root", "ticoncloud-platform", "workspace:*", "link:../.."],
    ["to a folder that is no project", "x", "link:../../packages", "link:../../packages"],
    ["out of the repository", "x", "link:../../../x", "link:../../../x"],
    ["to a folder named constructor", "x", "link:../../constructor", "link:../../constructor"],
    ["to a folder named toString", "x", "link:../../toString", "link:../../toString"],
  ])("S8: a link %s stops the reader", (_, key, specifier, version) => {
    const root = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": { ...WEB, dependencies: { [key]: specifier } },
        "packages/aws": { name: "@tc/aws" },
      },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      ${key}:
        specifier: ${specifier}
        version: ${version}

  packages/aws: {}
`,
    );
    expect(() => readInstalledGraph(root)).toThrow(
      new RegExp(
        `apps/web: ${key} is linked to a folder that is not a package under apps/, packages/ or functions/`,
      ),
    );
  });

  it("S9: file:, a local tarball and a URL stop the reader", () => {
    const injected = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": { ...WEB, dependencies: { "@tc/aws": "workspace:*" } },
        "packages/aws": { name: "@tc/aws" },
      },
      `${HEAD}
importers:

  .: {}

  apps/web:
    dependencies:
      '@tc/aws':
        specifier: workspace:*
        version: file:packages/aws

  packages/aws: {}
`,
    );
    expect(() => readInstalledGraph(injected)).toThrow(
      /apps\/web: @tc\/aws is resolved in a form this file does not understand/,
    );
    const tarball = webDepends(
      { x: "my aws.tgz" },
      `      x:
        specifier: my aws.tgz
        version: '@tc/aws@file:apps/web/my aws.tgz'`,
      `
packages:

  '@tc/aws@file:apps/web/my aws.tgz':
    resolution: {integrity: ${SUM}, tarball: file:apps/web/my aws.tgz}
    version: 0.0.0

snapshots:

  '@tc/aws@file:apps/web/my aws.tgz': {}
`,
    );
    expect(() => readInstalledGraph(tarball)).toThrow(
      /apps\/web: x is resolved in a form this file does not understand/,
    );
    const url = webDepends(
      { ms: "github:vercel/ms#2.1.3" },
      `      ms:
        specifier: github:vercel/ms#2.1.3
        version: https://codeload.github.com/vercel/ms/tar.gz/1c6264b795492e8fdecbc82cb8802fcfbfc08d26`,
      `
packages:

  ms@https://codeload.github.com/vercel/ms/tar.gz/1c6264b795492e8fdecbc82cb8802fcfbfc08d26:
    resolution: {tarball: https://codeload.github.com/vercel/ms/tar.gz/1c6264b795492e8fdecbc82cb8802fcfbfc08d26}
    version: 2.1.3

snapshots:

  ms@https://codeload.github.com/vercel/ms/tar.gz/1c6264b795492e8fdecbc82cb8802fcfbfc08d26: {}
`,
    );
    expect(() => readInstalledGraph(url)).toThrow(
      /apps\/web: ms is resolved in a form this file does not understand/,
    );
  });

  it("S10: a registry version without its snapshot, or without its package entry", () => {
    const ms = `      ms:
        specifier: 2.1.3
        version: 2.1.3`;
    const noSnapshot = webDepends(
      { ms: "2.1.3" },
      ms,
      `\npackages:\n\n  ms@2.1.3:\n    resolution: {integrity: ${SUM}}\n`,
    );
    expect(() => readInstalledGraph(noSnapshot)).toThrow(
      /apps\/web: ms is resolved in a form this file does not understand/,
    );
    const noPackage = webDepends({ ms: "2.1.3" }, ms, `\nsnapshots:\n\n  ms@2.1.3: {}\n`);
    expect(() => readInstalledGraph(noPackage)).toThrow(
      /apps\/web: ms is resolved in a form this file does not understand/,
    );
  });

  describe("S11: a package entry that is not resolved by integrity alone", () => {
    const resolutions = [
      ["a directory", "{directory: packages/aws, type: directory}"],
      ["a tarball next to the checksum", `{integrity: ${SUM}, tarball: file:evil.tgz}`],
    ];
    it.each(resolutions)("%s, as a dependency of an app", (_, resolution) => {
      const root = webDepends(
        { ms: "2.1.3" },
        `      ms:
        specifier: 2.1.3
        version: 2.1.3`,
        `\npackages:\n\n  ms@2.1.3:\n    resolution: ${resolution}\n\nsnapshots:\n\n  ms@2.1.3: {}\n`,
      );
      expect(() => readInstalledGraph(root)).toThrow(
        /apps\/web: ms is resolved in a form this file does not understand/,
      );
    });
    it.each(resolutions)("%s, as a dependency of a third-party package", (_, resolution) => {
      const root = webDepends(
        { debug: "4.4.3" },
        `      debug:
        specifier: 4.4.3
        version: 4.4.3`,
        `
packages:

  debug@4.4.3:
    resolution: {integrity: ${SUM}}
    engines: {node: '>=6.0'}

  ms@2.1.3:
    resolution: ${resolution}

snapshots:

  debug@4.4.3:
    dependencies:
      ms: 2.1.3

  ms@2.1.3: {}
`,
      );
      expect(() => readInstalledGraph(root)).toThrow(
        /the package ms@2\.1\.3 is not resolved from the registry by its checksum alone/,
      );
    });
  });

  it("S12: a snapshot whose dependency is a link stops the reader", () => {
    const root = workspace(
      {
        ".": ROOT_PKG,
        "apps/web": { ...WEB, dependencies: { debug: "4.4.3" } },
        "packages/aws": { name: "@tc/aws" },
      },
      `${HEAD}
overrides:
  debug>ms: link:./packages/aws

importers:

  .: {}

  apps/web:
    dependencies:
      debug:
        specifier: 4.4.3
        version: 4.4.3

  packages/aws: {}

packages:

  debug@4.4.3:
    resolution: {integrity: ${SUM}}
    engines: {node: '>=6.0'}

snapshots:

  debug@4.4.3:
    dependencies:
      ms: link:packages/aws
`,
    );
    expect(() => readInstalledGraph(root)).toThrow(
      /the installed package debug@4\.4\.3 depends on ms in a form this file does not understand/,
    );
  });

  it("S13: a package.json that is not JSON, of a project or of the root", () => {
    const lock = `${HEAD}\nimporters:\n\n  .: {}\n\n  apps/web: {}\n`;
    const project = workspace({ ".": ROOT_PKG, "apps/web": "{ not json" }, lock);
    expect(() => readInstalledGraph(project)).toThrow(
      /^installed-graph: a package\.json under apps\/, packages\/ or functions\/ cannot be read as JSON$/,
    );
    const rootPkg = workspace({ ".": "{ not json", "apps/web": WEB }, lock);
    expect(() => readInstalledGraph(rootPkg)).toThrow(
      /^installed-graph: package\.json cannot be read as JSON$/,
    );
  });

  it("S14: the message for an unknown form names the project and the key, not the value", () => {
    const secret = "https://user:tok3n@example.test/x.tgz";
    const root = webDepends(
      { x: secret },
      `      x:
        specifier: ${secret}
        version: ${secret}`,
      "",
    );
    let message = "";
    try {
      readInstalledGraph(root);
    } catch (error) {
      message = String(error.message);
    }
    expect(message).toMatch(/^installed-graph: apps\/web: x is resolved in a form/);
    expect(message).not.toContain("tok3n");
  });
});

describe("readDirectLinks lists what a node_modules folder really holds", () => {
  const root = workspace(
    { ".": ROOT_PKG, "apps/web": WEB, "packages/aws": { name: "@tc/aws" } },
    null,
  );
  const copy = join(root, "node_modules/.pnpm/x/node_modules/@tc/aws");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "package.json"), JSON.stringify({ name: "@tc/aws" }));
  const nm = join(root, "apps/web/node_modules");
  mkdirSync(join(nm, "@tc"), { recursive: true });
  mkdirSync(join(nm, ".pnpm"));
  mkdirSync(join(nm, ".bin"));
  writeFileSync(join(nm, ".modules.yaml"), "");
  symlinkSync("../../../../packages/aws", join(nm, "@tc/aws"), "dir");
  symlinkSync("../../../packages/aws", join(nm, "innocent"), "dir");
  symlinkSync("../../../node_modules/.pnpm/x/node_modules/@tc/aws", join(nm, "ms"), "dir");
  symlinkSync("../../..", join(nm, "up"), "dir");
  symlinkSync("../nowhere", join(nm, "gone"), "dir");

  it("follows each entry to its real folder and reads the name found there", () => {
    expect(readDirectLinks(root, "apps/web")).toEqual([
      { name: "@tc/aws", target: "packages/aws", packageName: "@tc/aws" },
      { name: "gone", target: null, packageName: null },
      { name: "innocent", target: "packages/aws", packageName: "@tc/aws" },
      {
        name: "ms",
        target: "node_modules/.pnpm/x/node_modules/@tc/aws",
        packageName: "@tc/aws",
      },
      { name: "up", target: ".", packageName: "ticoncloud-platform" },
    ]);
  });

  it("a copy under node_modules keeps the name in its package.json", () => {
    const ms = readDirectLinks(root, "apps/web").find((link) => link.name === "ms");
    expect(ms.target.startsWith("node_modules/")).toBe(true);
    expect(ms.packageName).toBe("@tc/aws");
  });

  it("a folder without node_modules holds nothing", () => {
    expect(readDirectLinks(root, "packages/aws")).toEqual([]);
  });
});
