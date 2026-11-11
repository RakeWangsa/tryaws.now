import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { awsSdkClients } from "../../eslint.config.mjs";
import { readWorkspacePackages } from "../../scripts/lib/changed-packages.mjs";

const SDK = awsSdkClients;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dirs = readWorkspacePackages(ROOT);
const dirOf = Object.fromEntries(Object.entries(dirs).map(([dir, name]) => [name, dir]));

// Which package does a dependency value (the value in a package.json map) lead to? The function
// understands five kinds and throws for everything else; it has no default:
//   1. a local path (file:, link:, portal:, workspace:./ or workspace:../, or a bare path that
//      starts with ".", "/", "~/" or a drive letter): the workspace package in that folder, and
//      a throw if the folder is no workspace package;
//   2. a version, range or tag of the registry: the key itself;
//   3. workspace: followed by such a range ("workspace:*"): the key itself;
//   4. an alias ("workspace:@tc/aws@*", "npm:@aws-sdk/client-sts@3", "npm:left-pad"): the name;
//   5. a value that is not a string: a throw (it is covered by the throw for unknown forms).
// Why a throw and not a guess: a dependency value can lead to another folder only if it holds a
// path separator, "..", an absolute path, a home reference or a protocol. A value with none of
// these is a version, a range or a tag. So everything outside the five kinds is refused, and the
// error does not print it (a URL could hold a token).
// What this test cannot see: a symbolic link inside the repository, and anything that pnpm reads
// outside package.json and pnpm-workspace.yaml (the last test below watches the known routes).
// IAM is the boundary that holds (the apps cannot assume a pool role). This test and the lint
// rule catch accidents and make a deliberate route visible in review.
const NAME = String.raw`(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)`;
const REGISTRY_RANGE = /^[^/\\:]*$/;
const ALIAS = new RegExp(
  String.raw`^(?:workspace:(${NAME})@([^/\\:]+)|npm:(${NAME})(?:@([^/\\:]+))?)$`,
);
const LOCAL_PATH =
  /^(?:(?:file|link|portal):|workspace:(?=\.|\/|~\/))(.+)$|^((?:\.|\/|~\/|[A-Za-z]:[\\/]).*)$/;

function targetOf(dir, key, spec) {
  if (typeof spec === "string") {
    const local = LOCAL_PATH.exec(spec);
    if (local) {
      const target = local[1] ?? local[2];
      const folder = posix
        .normalize(isAbsolute(target) ? relative(ROOT, target) : posix.join(dir, target))
        .replace(/\/+$/, "");
      if (dirs[folder] !== undefined) return dirs[folder];
      throw new Error(
        `aws-boundary: ${dir} depends on ${key} through the local path "${spec}", which is not a workspace package; add it to this test before it is used`,
      );
    }
    if (REGISTRY_RANGE.test(spec)) return key;
    const workspaceRange = /^workspace:([^/\\:]*)$/.exec(spec);
    if (workspaceRange) return key;
    const alias = ALIAS.exec(spec);
    if (alias) return alias[1] ?? alias[3];
  }
  throw new Error(
    `aws-boundary: ${dir} depends on ${key} through a value this test does not understand (see ${dir}/package.json); add the form to this test before it is used`,
  );
}

const deps = Object.fromEntries(
  Object.entries(dirs).map(([dir, name]) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
    const entries = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
      pkg.optionalDependencies,
    ].flatMap((group) => Object.entries(group ?? {}));
    return [name, entries.map(([key, spec]) => targetOf(dir, key, spec))];
  }),
);

function reachable(graph, start) {
  const seen = new Set();
  const todo = [start];
  while (todo.length) {
    const next = todo.pop();
    for (const d of graph[next] ?? []) {
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

it.each([
  ["@tc/aws", "workspace:*", "@tc/aws"],
  ["aws-alias", "workspace:@tc/aws@*", "@tc/aws"],
  ["sts", "npm:@aws-sdk/client-sts@3.1166.0", "@aws-sdk/client-sts"],
  ["x", "file:../aws", "@tc/aws"],
  ["x", "link:../../packages/aws", "@tc/aws"],
  ["x", "portal:../aws", "@tc/aws"],
  ["left-pad", "1.3.0", "left-pad"],
  ["x", "link:../aws/", "@tc/aws"],
  ["x", "file:./../aws/", "@tc/aws"],
  ["x", "workspace:../aws", "@tc/aws"],
  ["x", "workspace:../aws/", "@tc/aws"],
  ["x", "workspace:./../../packages/aws", "@tc/aws"],
  ["x", "link:../../functions/reader", "@tc/fn-reader"],
  ["x", "workspace:^", "x"],
  ["x", "workspace:~1.2.3", "x"],
  ["x", "../aws", "@tc/aws"],
  ["x", "../aws/", "@tc/aws"],
  ["x", "./../aws", "@tc/aws"],
  ["x", "../../packages/aws", "@tc/aws"],
  ["x", "../../functions/reader", "@tc/fn-reader"],
  ["x", ".", "@tc/db"],
  ["x", "^1.2.3", "x"],
  ["x", "~1.2.3", "x"],
  ["x", "*", "x"],
  ["x", "latest", "x"],
  ["x", ">=1.0.0 <2.0.0", "x"],
  ["x", "1.x || 2.x", "x"],
  ["x", "1.2.3-beta.1", "x"],
  ["x", "", "x"],
  ["x", "workspace:^1.2.3", "x"],
  ["x", "npm:left-pad", "left-pad"],
  ["x", "npm:7zip-min@1", "7zip-min"],
  ["x", "npm:@tc/fn-reader@*", "@tc/fn-reader"],
])("the dependency %s: %s points at %s", (key, spec, expected) => {
  expect(targetOf("packages/db", key, spec)).toBe(expected);
});

it("an absolute local path is followed too", () => {
  expect(targetOf("apps/web", "x", join(ROOT, "packages/aws"))).toBe("@tc/aws");
  expect(targetOf("packages/db", "x", `file:${join(ROOT, "packages/aws")}`)).toBe("@tc/aws");
  expect(targetOf("apps/web", "x", `link:${join(ROOT, "packages/aws")}/`)).toBe("@tc/aws");
});

it.each([
  "file:../not-a-package",
  "link:../../somewhere-else",
  "portal:./vendor/x",
  "file:../aws.tgz",
  "workspace:../not-a-package",
  "../not-a-package",
  "./vendor/x",
  "~/x",
  "workspace:~/x",
  "C:\\\\x\\\\aws",
])("a local path that is not a workspace package stops the test: %s", (spec) => {
  expect(() => targetOf("packages/db", "x", spec)).toThrow(/is not a workspace package/);
});

it.each([
  ["catalog:"],
  ["catalog:default"],
  ["git+https://example.test/x.git"],
  ["github:owner/repo"],
  ["owner/repo"],
  ["packages/aws"],
  ["https://example.test/x.tgz"],
  ["LINK:../aws"],
  ["workspace:@TC/AWS@*"],
  ["npm: @tc/aws@*"],
  ["npm:@tc/aws@../aws"],
  [1],
  [null],
  [undefined],
  [{}],
  [["link:../aws"]],
])("a value the test does not understand stops it: %j", (spec) => {
  expect(() => targetOf("packages/db", "x", spec)).toThrow(/does not understand/);
});

it("the error for an unknown value does not print the value", () => {
  const secret = "git+https://user:tok3n@example.test/x.git";
  let message = "";
  try {
    targetOf("packages/db", "x", secret);
  } catch (error) {
    message = String(error.message);
  }
  expect(message).toContain("packages/db/package.json");
  expect(message).not.toContain("tok3n");
});

it("nothing outside the dependency maps can redirect a dependency (R1)", () => {
  // When this fails: teach this file to read the new setting and to pass its values through targetOf, then widen this test.
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(Object.keys(root).filter((k) => ["overrides", "resolutions"].includes(k))).toEqual([]);
  expect(
    Object.keys(root.pnpm ?? {}).filter((k) => ["overrides", "packageExtensions"].includes(k)),
  ).toEqual([]);
  const settings = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const redirecting = settings
    .split("\n")
    .map((line) => /^([A-Za-z]+)\s*:/.exec(line)?.[1])
    .filter((k) => ["overrides", "catalog", "catalogs", "packageExtensions"].includes(k));
  expect(redirecting).toEqual([]);
  expect([".pnpmfile.cjs", ".pnpmfile.mjs"].filter((f) => existsSync(join(ROOT, f)))).toEqual([]);
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

it("only functions/ may depend on @tc/aws (R1)", () => {
  expect(Object.keys(deps)).toContain("@tc/aws");
  const offenders = Object.entries(deps)
    .filter(([name, list]) => list.includes("@tc/aws") && !dirOf[name].startsWith("functions/"))
    .map(([name]) => name);
  expect(offenders).toEqual([]);
});

it("only packages/aws depends on the AWS clients of section 4 or on credential providers", () => {
  expect(deps["@tc/aws"].some((d) => SDK.includes(d))).toBe(true);
  const offenders = Object.entries(deps)
    .filter(([name, list]) => name !== "@tc/aws" && list.some((d) => SDK.includes(d)))
    .map(([name]) => name);
  expect(offenders).toEqual([]);
});

it("apps/web and apps/admin cannot reach @tc/aws or a function through any workspace package", () => {
  for (const app of ["@tc/web", "@tc/admin"]) {
    expect(Object.keys(deps)).toContain(app);
    const found = [...reachable(deps, app)].filter(
      (d) => d === "@tc/aws" || d.startsWith("@tc/fn-") || SDK.includes(d),
    );
    expect({ app, found }).toEqual({ app, found: [] });
  }
});
