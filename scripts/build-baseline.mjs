// Writes verify/baseline.json from TICON_CLOUD_MEGA_PLAN.md. With --check it only compares.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildBaseline, PLAN_FILE } from "./lib/baseline.mjs";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "verify/baseline.json");
const out = (text) => process.stdout.write(`${text}\n`);

const wanted = `${JSON.stringify(buildBaseline(readFileSync(resolve(root, PLAN_FILE), "utf8")), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = null;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing file counts as out of date.
  }
  if (current !== wanted) {
    out("verify/baseline.json is out of date. Run pnpm baseline:build.");
    process.exitCode = 1;
  }
} else {
  writeFileSync(target, wanted);
  out("written: verify/baseline.json");
}
