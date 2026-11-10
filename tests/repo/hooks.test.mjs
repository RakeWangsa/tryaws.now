import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { childEnv } from "./child-env.mjs";

const protect = resolve(".claude/hooks/protect-files.sh");
const stopCheck = resolve(".claude/hooks/stop-check.sh");
const run = (script, input, env = {}) =>
  spawnSync("bash", [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: childEnv(env),
  });
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: childEnv() });

// A small repository like the real one: one merged migration, an ignored node_modules folder and a
// committed scripts/verify.mjs. The two options leave out what stop-check.sh looks for.
function repo({ installed = true, verifyScript = true } = {}) {
  // realpath: on macOS the temp folder is a symlink and git reports the real path
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hook-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "packages/db/migrations"), { recursive: true });
  writeFileSync(join(dir, "packages/db/migrations/0001_init.sql"), "select 1;\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  if (verifyScript) {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/verify.mjs"), "\n");
  }
  if (installed) mkdirSync(join(dir, "node_modules"));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

it("builds its test repository even when GIT_DIR points elsewhere", () => {
  const saved = process.env.GIT_DIR;
  const elsewhere = join(mkdtempSync(join(tmpdir(), "gitdir-")), "missing");
  try {
    process.env.GIT_DIR = elsewhere;
    const dir = repo();
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(elsewhere)).toBe(false);
    const head = git(dir, "rev-parse", "HEAD");
    expect(head.status, head.stderr).toBe(0);
    expect(git(dir, "log", "-1", "--format=%s").stdout.trim()).toBe("init");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

it.each([
  ["/repo/design/mockup/template/index.html", "design/mockup"],
  ["/repo/docs/spec/08-pricing-engine.md", "docs/spec"],
  ["/repo/.env", "env files"],
  ["/repo/apps/web/.env.local", "env files"],
])("protect-files blocks %s", (file_path, word) => {
  const result = run(protect, { tool_input: { file_path }, cwd: "/repo" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Blocked:");
  expect(result.stderr).toContain(word);
});
it.each([
  [{ tool_input: { file_path: "/repo/packages/core/src/pricing.ts" }, cwd: "/repo" }],
  [{ tool_input: { file_path: "/repo/docs/my notes (v2).md" }, cwd: "/repo" }],
  [{ tool_input: {}, cwd: "/repo" }],
])("protect-files allows %j", (input) => {
  expect(run(protect, input).status).toBe(0);
});
it("protect-files blocks a migration that is on origin/main and allows a new one", () => {
  const dir = repo();
  const merged = run(protect, {
    tool_input: { file_path: join(dir, "packages/db/migrations/0001_init.sql") },
    cwd: dir,
  });
  expect(merged.status).toBe(2);
  expect(merged.stderr).toContain("forward-only");
  const fresh = run(protect, {
    tool_input: { file_path: join(dir, "packages/db/migrations/0002_next.sql") },
    cwd: dir,
  });
  expect(fresh.status).toBe(0);
});

function fakePnpm(exitCode) {
  const bin = mkdtempSync(join(tmpdir(), "bin-"));
  writeFileSync(join(bin, "pnpm"), `#!/bin/bash\necho "fake verify output"\nexit ${exitCode}\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}
it("stop-check does nothing when the stop hook is already active", () => {
  const dir = repo();
  writeFileSync(join(dir, "dirty.txt"), "x\n");
  expect(run(stopCheck, { stop_hook_active: true, cwd: dir }, fakePnpm(1)).status).toBe(0);
});
it("stop-check does nothing in a clean tree", () => {
  expect(run(stopCheck, { stop_hook_active: false, cwd: repo() }, fakePnpm(1)).status).toBe(0);
});
it("stop-check blocks when files changed and the quick check fails", () => {
  const dir = repo();
  writeFileSync(join(dir, "dirty.txt"), "x\n");
  const result = run(stopCheck, { stop_hook_active: false, cwd: dir }, fakePnpm(1));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("pnpm verify --quick failed");
  expect(result.stderr).toContain("fake verify output");
});
it("stop-check passes when files changed and the quick check passes", () => {
  const dir = repo();
  writeFileSync(join(dir, "dirty.txt"), "x\n");
  expect(run(stopCheck, { stop_hook_active: false, cwd: dir }, fakePnpm(0)).status).toBe(0);
});
it("stop-check works from the repository root when the session is in a subfolder", () => {
  const dir = repo();
  writeFileSync(join(dir, "dirty.txt"), "x\n");
  const result = run(
    stopCheck,
    { stop_hook_active: false, cwd: join(dir, "packages") },
    fakePnpm(1),
  );
  expect(result.status).toBe(2);
});
it.each([
  ["pnpm install has not run", { installed: false }],
  ["scripts/verify.mjs does not exist yet", { verifyScript: false }],
])("stop-check skips the check while %s", (_, options) => {
  const dir = repo(options);
  writeFileSync(join(dir, "dirty.txt"), "x\n");
  expect(run(stopCheck, { stop_hook_active: false, cwd: dir }, fakePnpm(1)).status).toBe(0);
});

// The PostToolUse hook is one shell line inside settings.json. A fake npx records what it is given.
const format = JSON.parse(readFileSync(".claude/settings.json", "utf8")).hooks.PostToolUse[0]
  .hooks[0].command;
function fakeNpx() {
  const bin = mkdtempSync(join(tmpdir(), "bin-"));
  const log = join(bin, "calls.txt");
  writeFileSync(join(bin, "npx"), `#!/bin/bash\nprintf '%s\\n' "$#" "$@" >> "${log}"\n`);
  chmodSync(join(bin, "npx"), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
}
const runFormat = (input, env) =>
  spawnSync("bash", ["-c", format], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: childEnv(env),
  });

it("the format hook passes a path with spaces as one argument", () => {
  const { env, log } = fakeNpx();
  expect(runFormat({ tool_input: { file_path: "/tmp/my folder/a b.ts" } }, env).status).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "4",
    "prettier",
    "--write",
    "--ignore-unknown",
    "/tmp/my folder/a b.ts",
  ]);
});
it.each([
  [{ tool_input: { file_path: "/repo/TICON_CLOUD_MEGA_PLAN.md" } }],
  [{ tool_input: { file_path: "/repo/content/help/first.mdx" } }],
  [{ tool_input: {} }],
])("the format hook does nothing for %j", (input) => {
  const { env, log } = fakeNpx();
  expect(runFormat(input, env).status).toBe(0);
  expect(existsSync(log)).toBe(false);
});
