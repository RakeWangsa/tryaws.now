import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { diffAgainstDisk, sectionFileName, splitPlan, writeSpec } from "./split-plan.mjs";

const HEADER = (range) =>
  `<!-- GENERATED, do not edit. Source: PLAN.md${range}. Change the plan, then run pnpm spec:split. -->`;

it("names files after the section id and heading", () => {
  expect(sectionFileName("E. Backlog and prompts")).toBe("E-backlog-and-prompts.md");
  expect(sectionFileName("8. Pricing engine")).toBe("08-pricing-engine.md");
  expect(sectionFileName("9. Wallet, ledger and EPS")).toBe("09-wallet-ledger-and-eps.md");
  expect(sectionFileName("F. Contracts between tracks")).toBe("F-contracts-between-tracks.md");
  expect(sectionFileName("P. `CLAUDE.md`")).toBe("P-claude-md.md");
  expect(sectionFileName("K. Go/no-go on Monday 16 at 18:00")).toBe(
    "K-go-no-go-on-monday-16-at-18-00.md",
  );
  expect(sectionFileName("16. Screens and UI")).toBe("16-screens-and-ui.md");
});

const small = [
  "# Plan",
  "intro",
  "# Part 1. Start",
  "",
  "## A. One",
  "```markdown",
  "# Not a title",
  "## Not a section",
  "```",
  "text",
  "# Part 2. Build",
  "## 3. Two",
  "x",
].join("\n");

it("splits on level-2 headings and ignores headings inside fences", () => {
  const files = splitPlan(small, "PLAN.md");
  expect([...files.keys()]).toEqual(["_plan-header.md", "A-one.md", "03-two.md", "INDEX.md"]);
  expect(files.get("A-one.md")).toBe(
    [
      HEADER(" lines 5-10"),
      "",
      "## A. One",
      "```markdown",
      "# Not a title",
      "## Not a section",
      "```",
      "text",
      "",
    ].join("\n"),
  );
});
it("collects the title block and the Part headings in _plan-header.md", () => {
  expect(splitPlan(small, "PLAN.md").get("_plan-header.md")).toBe(
    [HEADER(""), "", "# Plan", "intro", "# Part 1. Start", "", "# Part 2. Build", ""].join("\n"),
  );
});
it("lists every file with its heading in INDEX.md", () => {
  const index = splitPlan(small, "PLAN.md").get("INDEX.md");
  expect(index).toContain("# Specification index");
  expect(index).toContain("| `A-one.md` | A. One | 5-10 |");
  expect(index).toContain("| `03-two.md` | 3. Two | 12-13 |");
});

function big(lines) {
  const body = ["## E. Big", "before", "### E.1 First part", "a", "### E.2 Second (part)", "b"];
  while (body.length < lines) body.push("filler");
  return ["# Plan", ...body, "## F. Next", "z"].join("\n");
}
it("gives a section of more than 150 lines a folder with one file per subsection", () => {
  const keys = [...splitPlan(big(151), "PLAN.md").keys()];
  expect(keys).toEqual([
    "_plan-header.md",
    "E-big.md",
    "E/E-intro.md",
    "E/E.1-first-part.md",
    "E/E.2-second-part.md",
    "F-next.md",
    "INDEX.md",
  ]);
});
it("gives a section of exactly 150 lines no folder", () => {
  expect([...splitPlan(big(150), "PLAN.md").keys()].some((k) => k.includes("/"))).toBe(false);
});

it("reports missing, changed and stray files", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  const files = splitPlan(small, "PLAN.md");
  writeFileSync(join(dir, "A-one.md"), "edited by hand\n");
  writeFileSync(join(dir, "03-two.md"), files.get("03-two.md"));
  mkdirSync(join(dir, "Z"));
  writeFileSync(join(dir, "Z", "old.md"), "left over\n");
  expect(diffAgainstDisk(files, dir)).toEqual({
    missing: ["INDEX.md", "_plan-header.md"],
    changed: ["A-one.md"],
    stray: ["Z/old.md"],
  });
  expect(writeSpec(files, dir)).toEqual({ written: 4, removed: ["Z/old.md"] });
  expect(existsSync(join(dir, "Z"))).toBe(false);
  expect(diffAgainstDisk(files, dir)).toEqual({ missing: [], changed: [], stray: [] });
});
