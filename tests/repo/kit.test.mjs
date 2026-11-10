import { readFileSync, statSync } from "node:fs";
import { expect, it } from "vitest";
import { blockAfter, sectionRange, tablesIn } from "../../scripts/lib/md.mjs";

const plan = readFileSync("TICON_CLOUD_MEGA_PLAN.md", "utf8");
const read = (file) => readFileSync(file, "utf8");

it.each([
  ["CLAUDE.md", "## P. `CLAUDE.md`"],
  [".claude/settings.json", "`.claude/settings.json`"],
  [".claude/hooks/protect-files.sh", "`.claude/hooks/protect-files.sh`"],
  [".claude/hooks/stop-check.sh", "`.claude/hooks/stop-check.sh`"],
  [".worktreeinclude", "`.worktreeinclude`"],
  [".claude/skills/wp-start/SKILL.md", "`.claude/skills/wp-start/SKILL.md`"],
  [".claude/skills/wp-verify/SKILL.md", "`.claude/skills/wp-verify/SKILL.md`"],
  [".claude/skills/handoff/SKILL.md", "`.claude/skills/handoff/SKILL.md`"],
  [".claude/agents/security-reviewer.md", "`.claude/agents/security-reviewer.md`"],
  [".claude/agents/money-reviewer.md", "`.claude/agents/money-reviewer.md`"],
  [".claude/agents/spec-checker.md", "`.claude/agents/spec-checker.md`"],
  [".github/pull_request_template.md", "Pull request description:"],
])("%s is the plan's block, unchanged", (file, marker) => {
  expect(read(file)).toBe(blockAfter(plan, marker));
});

it("CLAUDE.md is under 200 lines", () => {
  expect(read("CLAUDE.md").split("\n").length).toBeLessThan(200);
});
it("settings.json is valid and has the three hook events", () => {
  const settings = JSON.parse(read(".claude/settings.json"));
  expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
  for (const list of ["allow", "ask", "deny"])
    expect(Array.isArray(settings.permissions[list])).toBe(true);
});
it("the hook scripts are executable", () => {
  for (const file of [".claude/hooks/protect-files.sh", ".claude/hooks/stop-check.sh"]) {
    expect(statSync(file).mode & 0o111, file).not.toBe(0);
  }
});
it(".gitignore holds every line of the plan's block", () => {
  const lines = read(".gitignore").split("\n");
  for (const line of blockAfter(plan, "Lines to add to `.gitignore`").trim().split("\n")) {
    expect(lines, line).toContain(line);
  }
});
it("JOURNEY.md starts with the entry form", () => {
  const form =
    "# JOURNEY\n\nOne entry per task or handoff, newest last. Copy this form:\n\n```markdown\n" +
    blockAfter(plan, "`JOURNEY.md` entry:") +
    "```\n";
  expect(read("JOURNEY.md").startsWith(form)).toBe(true);
});

function ruleText(id) {
  const range = sectionRange(
    plan,
    id.startsWith("U") ? "16.2 UI rules" : "2. Rules that are never broken",
  );
  const row = tablesIn(plan, range.start, range.end)[0].rows.find((r) => r[0] === id);
  return row[1];
}
function idsOf(body) {
  const range = body.match(/U(\d+) to U(\d+)/);
  if (range)
    return Array.from({ length: range[2] - range[1] + 1 }, (_, i) => `U${Number(range[1]) + i}`);
  return body
    .split(" in full")[0]
    .split(",")
    .map((s) => s.trim());
}
const r = sectionRange(plan, "R. Path-scoped rules");
const ruleRows = tablesIn(plan, r.start, r.end)[0].rows;

it("Appendix R names seven rule files", () => {
  expect(ruleRows.map((row) => row[0])).toEqual([
    "`money.md`",
    "`aws.md`",
    "`data.md`",
    "`ui.md`",
    "`admin.md`",
    "`lifecycle.md`",
    "`server.md`",
  ]);
});
it.each(ruleRows)(
  "rule file %s has the row's paths and the full text of its rules",
  (file, paths, body) => {
    const text = read(`.claude/rules/${file.replaceAll("`", "")}`);
    const expectedPaths = paths.split(",").map((p) => `  - "${p.trim().replaceAll("`", "")}"`);
    expect(text.startsWith(["---", "paths:", ...expectedPaths, "---", "", "# "].join("\n"))).toBe(
      true,
    );
    for (const id of idsOf(body)) expect(text, id).toContain(`\n**${id}.** ${ruleText(id)}\n`);
  },
);
it("money.md ends with the three bullets of the plan's example", () => {
  const example = blockAfter(plan, "Example, `.claude/rules/money.md`").trim().split("\n");
  const bullets = example.filter((line) => line.startsWith("- "));
  expect(bullets).toHaveLength(3);
  expect(read(".claude/rules/money.md").trim().split("\n").slice(-3)).toEqual(bullets);
});

const owners = read(".github/CODEOWNERS")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => line.split(/\s+/));
it("CODEOWNERS covers the paths of spec E.1, each with the two placeholder owners", () => {
  expect(owners.map((rule) => rule[0])).toEqual([
    "/packages/core/pricing/",
    "/packages/core/ledger/",
    "/packages/core/orders/",
    "/packages/eps/",
    "/functions/payments-sweeper/",
    "/packages/auth/",
    "/infra/",
    "/sst.config.ts",
    "/.claude/",
    "/CLAUDE.md",
    "/.github/",
    "/scripts/verify.mjs",
    "/scripts/split-plan.mjs",
    "/verify/",
  ]);
  for (const rule of owners) {
    expect(rule.slice(1), rule[0]).toEqual(["@REPLACE-WITH-LEAD", "@REPLACE-WITH-SECOND-REVIEWER"]);
  }
});
it("CODEOWNERS covers every path of the money rule file", () => {
  const moneyPaths = ruleRows
    .find((row) => row[0] === "`money.md`")[1]
    .split(",")
    .map((path) => "/" + path.trim().replaceAll("`", "").replace("**", ""));
  expect(moneyPaths).toHaveLength(5);
  for (const path of moneyPaths)
    expect(
      owners.map((rule) => rule[0]),
      path,
    ).toContain(path);
});
it("the pricing engine sits where the money rule file looks for it", () => {
  // Appendix R scopes the money rules to packages/core/pricing/**, so the code must be at that path (Task 7).
  expect(ruleRows.find((row) => row[0] === "`money.md`")[1]).toContain(
    "`packages/core/pricing/**`",
  );
  expect(statSync("packages/core/pricing").isDirectory()).toBe(true);
});
