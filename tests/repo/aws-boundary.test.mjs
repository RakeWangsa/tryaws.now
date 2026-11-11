import { readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { awsSdkClients } from "../../eslint.config.mjs";
import { readWorkspacePackages } from "../../scripts/lib/changed-packages.mjs";

const SDK = awsSdkClients;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dirs = readWorkspacePackages(ROOT);
const dirOf = Object.fromEntries(Object.entries(dirs).map(([dir, name]) => [name, dir]));

// "aws-alias": "workspace:@tc/aws@*"  ->  @tc/aws
// "sts": "npm:@aws-sdk/client-sts@3"  ->  @aws-sdk/client-sts
// "x": "file:../aws" or "link:../aws" or "workspace:../aws" -> the workspace package in that folder
// A local path that names no workspace package throws: the test fails closed.
function targetOf(dir, key, spec) {
  const path = /^(?:(?:file|link|portal):|workspace:(?=[./]))(.+)$/.exec(spec);
  if (path) {
    const target = path[1];
    const folder = posix
      .normalize(isAbsolute(target) ? relative(ROOT, target) : posix.join(dir, target))
      .replace(/\/+$/, "");
    if (dirs[folder] !== undefined) return dirs[folder];
    throw new Error(
      `aws-boundary: ${dir} depends on ${key} through the local path "${spec}", which is not a workspace package; add it to this test before it is used`,
    );
  }
  const alias = /^(?:workspace|npm):(@[^/@]+\/[^@]+|[a-z][^@]*)(?:@.*)?$/.exec(spec);
  if (alias) return alias[1];
  return key;
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
])("the dependency %s: %s points at %s", (key, spec, expected) => {
  expect(targetOf("packages/db", key, spec)).toBe(expected);
});

it("an absolute local path is followed too", () => {
  expect(targetOf("packages/db", "x", `file:${join(ROOT, "packages/aws")}`)).toBe("@tc/aws");
  expect(targetOf("apps/web", "x", `link:${join(ROOT, "packages/aws")}/`)).toBe("@tc/aws");
});

it.each([
  "file:../not-a-package",
  "link:../../somewhere-else",
  "portal:./vendor/x",
  "file:../aws.tgz",
  "workspace:../not-a-package",
])("a local path that is not a workspace package stops the test: %s", (spec) => {
  expect(() => targetOf("packages/db", "x", spec)).toThrow(/is not a workspace package/);
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
