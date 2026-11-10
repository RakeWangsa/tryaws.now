// Splits TICON_CLOUD_MEGA_PLAN.md into docs/spec/. With --check it only compares.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { diffAgainstDisk, splitPlan, writeSpec } from "./lib/split-plan.mjs";

const root = resolve(import.meta.dirname, "..");
const planPath = resolve(root, "TICON_CLOUD_MEGA_PLAN.md");
const specDir = resolve(root, "docs/spec");
const out = (text) => process.stdout.write(`${text}\n`);

const files = splitPlan(readFileSync(planPath, "utf8"));

if (process.argv.includes("--check")) {
  const diff = diffAgainstDisk(files, specDir);
  for (const key of ["missing", "changed", "stray"]) {
    out(`${key}: ${diff[key].length === 0 ? "none" : diff[key].join(", ")}`);
  }
  if (Object.values(diff).some((list) => list.length > 0)) {
    out("docs/spec is out of sync with the plan. Run pnpm spec:split.");
    process.exitCode = 1;
  }
} else {
  const { written, removed } = writeSpec(files, specDir);
  out(`written: ${written}`);
  out(`removed: ${removed.length}${removed.length === 0 ? "" : ` (${removed.join(", ")})`}`);
}
