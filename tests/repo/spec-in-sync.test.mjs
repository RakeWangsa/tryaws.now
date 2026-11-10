import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { headings } from "../../scripts/lib/md.mjs";
import { diffAgainstDisk, splitPlan } from "../../scripts/lib/split-plan.mjs";

const plan = readFileSync("TICON_CLOUD_MEGA_PLAN.md", "utf8");
const files = splitPlan(plan);
const top = [...files.keys()].filter(
  (k) => !k.includes("/") && !["INDEX.md", "_plan-header.md"].includes(k),
);

it("splits the real plan into its 40 sections", () => {
  expect(top).toHaveLength(40);
  expect(headings(plan).filter((h) => h.level === 2)).toHaveLength(40);
  for (const name of [
    "E-backlog-and-prompts.md",
    "F-contracts-between-tracks.md",
    "02-rules-that-are-never-broken.md",
    "08-pricing-engine.md",
    "09-wallet-ledger-and-eps.md",
    "16-screens-and-ui.md",
    "E/E.3-task-backlog.md",
    "16/16.13-states-wording-and-formats.md",
  ]) {
    expect(files.has(name), name).toBe(true);
  }
});
it("loses no line of the plan", () => {
  const planLines = plan.split("\n").length - (plan.endsWith("\n") ? 1 : 0);
  let lines = 0;
  for (const name of [...top, "_plan-header.md"]) lines += files.get(name).split("\n").length - 3;
  expect(lines).toBe(planLines);
});
it("docs/spec on disk is in sync with the plan", () => {
  expect(diffAgainstDisk(files, "docs/spec")).toEqual({ missing: [], changed: [], stray: [] });
});
