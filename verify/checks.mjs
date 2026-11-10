// What `pnpm verify` runs. A gate or task that is not listed here has no proof and fails (R16).
import { resolve } from "node:path";
import { readWorkspacePackages } from "../scripts/lib/changed-packages.mjs";

const root = resolve(import.meta.dirname, "..");

const specSync = {
  id: "spec-sync",
  title: "docs/spec matches the plan",
  command: ["pnpm", "spec:check"],
};
const baselineSync = {
  id: "baseline-sync",
  title: "verify/baseline.json matches the plan",
  command: ["pnpm", "baseline:check"],
};
const lint = { id: "lint", title: "ESLint", command: ["pnpm", "lint"] };
const typecheck = {
  id: "typecheck",
  title: "TypeScript in every package",
  command: ["pnpm", "typecheck"],
};
const test = { id: "test", title: "Vitest, all projects", command: ["pnpm", "test"] };

// The kit and the CI workflow are proven by the repo tests that `test` runs. "CI green" of
// gate M0 is the result of the pull request itself, not a local check.
const WP0_T1 = [specSync, baselineSync, lint, typecheck, test];

export const TASKS = { "WP0-T1": WP0_T1 };

export const GATES = {
  M0: WP0_T1,
  M1: [],
  M2: [],
  M3: [],
  M4: [],
  M5: [],
  M6: [],
  M7: [],
};

// `packages` holds package names (from changedPackages) or "all".
export function quickChecks(packages) {
  if (packages === "all") return [lint, typecheck, test];
  const folders = Object.entries(readWorkspacePackages(root))
    .filter(([, name]) => packages.includes(name))
    .map(([folder]) => folder);
  return [
    {
      id: "lint",
      title: "ESLint on the changed packages",
      command: ["pnpm", "exec", "eslint", ...folders],
    },
    {
      id: "typecheck",
      title: "TypeScript in the changed packages and what depends on them",
      command: ["pnpm", ...packages.flatMap((name) => ["--filter", `${name}...`]), "typecheck"],
    },
    {
      id: "test",
      title: "Vitest in the changed packages",
      command: ["pnpm", "test", ...packages.flatMap((name) => ["--project", name])],
    },
  ];
}
