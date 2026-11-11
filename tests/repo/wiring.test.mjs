import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob, posix } from "node:path";
import { expect, it } from "vitest";
import vitestConfig from "../../vitest.config.mjs";
import { readWorkspacePackages } from "../../scripts/lib/changed-packages.mjs";

// The wiring of the checks: these tests pin effects (what runs, what is skipped, which config is
// read), not only the strings of commands. Like the lint rules, they are tripwires for accidents
// and make a deliberate change visible in review; they are not the boundary of R1 (IAM, WP0-T5).

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// A folder is not walked when the root ESLint config ignores it, or when it is not source.
const NOT_WALKED = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".superpowers",
  ".remember",
  ".sst",
  ".next",
  ".open-next",
  "coverage",
  "dist",
]);
function filesBelow(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir === "." ? entry.name : posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_WALKED.has(entry.name)) filesBelow(path, found);
    } else {
      found.push(path);
    }
  }
  return found;
}

it("the only ESLint config of the repository is the root one", () => {
  const configs = filesBelow(".").filter((file) =>
    /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\..*)?)$/.test(file),
  );
  expect(configs).toEqual(["eslint.config.mjs"]);
});

it("the root scripts that the checks run are pinned", () => {
  const { scripts } = readJson("package.json");
  expect(scripts.lint).toBe("eslint -c eslint.config.mjs .");
  expect(scripts.test).toBe("node scripts/run-tests.mjs");
  expect(scripts.typecheck).toBe("pnpm -r typecheck");
  expect(scripts["format:check"]).toBe("prettier --check .");
});

it("vitest fails a test marked .only, also outside CI", () => {
  expect(vitestConfig.test.allowOnly).toBe(false);
});

it("the repo project runs the boundary tests and excludes nothing", () => {
  const repo = vitestConfig.test.projects.find(
    (project) => typeof project === "object" && project.test?.name === "repo",
  );
  expect(repo).toBeDefined();
  expect(repo.test.exclude).toBeUndefined();
  for (const file of [
    "tests/repo/aws-boundary.test.mjs",
    "tests/repo/import-boundaries.test.mjs",
    "tests/repo/wiring.test.mjs",
  ]) {
    expect(
      repo.test.include.some((pattern) => matchesGlob(file, pattern)),
      file,
    ).toBe(true);
  }
});

it("no repository test is skipped, focused or left as a todo", () => {
  const marker = new RegExp(String.raw`\.(skip|only|todo)\(|\b(xit|xdescribe)\(`);
  const found = [];
  for (const file of readdirSync("tests/repo").filter((name) => name.endsWith(".test.mjs"))) {
    readFileSync(`tests/repo/${file}`, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (marker.test(line)) found.push(`tests/repo/${file}:${i + 1}`);
      });
  }
  expect(found).toEqual([]);
});

// A lifecycle script of a workspace project runs in every install, CI included (pnpm blocks the
// scripts of dependencies, not those of the workspace). One could link packages/aws into the
// node_modules of a package that an app uses.
it("no workspace project and not the root has a lifecycle script", () => {
  const manifests = [
    "package.json",
    ...Object.keys(readWorkspacePackages(".")).map((dir) => `${dir}/package.json`),
  ];
  expect(manifests.length).toBeGreaterThan(20);
  const found = [];
  for (const file of manifests) {
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      if (Object.hasOwn(readJson(file).scripts ?? {}, name)) found.push(`${file}: ${name}`);
    }
  }
  expect(found).toEqual([]);
});
