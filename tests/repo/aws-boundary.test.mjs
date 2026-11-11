import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readWorkspacePackages } from "../../scripts/lib/changed-packages.mjs";

const SDK = [
  "@aws-sdk/client-lightsail",
  "@aws-sdk/client-route-53",
  "@aws-sdk/client-route-53-domains",
  "@aws-sdk/client-sts",
  "@aws-sdk/client-cost-explorer",
  "@aws-sdk/credential-providers",
];
const dirs = readWorkspacePackages(".");
const deps = Object.fromEntries(
  Object.entries(dirs).map(([dir, name]) => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    return [
      name,
      Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      }),
    ];
  }),
);
const dirOf = Object.fromEntries(Object.entries(dirs).map(([dir, name]) => [name, dir]));

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

it("the test bans the same AWS packages as the lint config", () => {
  const config = readFileSync("eslint.config.mjs", "utf8");
  for (const name of SDK) expect(config, name).toContain(`"${name}"`);
});

it("only functions/ may depend on @tc/aws (R1)", () => {
  expect(Object.keys(deps)).toContain("@tc/aws");
  const offenders = Object.entries(deps)
    .filter(([name, list]) => list.includes("@tc/aws") && !dirOf[name].startsWith("functions/"))
    .map(([name]) => name);
  expect(offenders).toEqual([]);
});

it("only packages/aws depends on the AWS clients of section 4 or on credential providers", () => {
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
