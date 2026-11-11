// node scripts/smoke-auth.mjs [--skip-seed]
// WP2-T2 Task 10: the proof of "Playwright completes sign-up to sign-in in bn at 360 px, locally against
// a fake identity provider". Steps, one summary line each:
//   1. refuse TC_STAGE staging or production and a database that is not local (R3);
//   2. check that the local database answers and is migrated;
//   3. seed the market the sign-up needs (skipped by --skip-seed);
//   4. check that @playwright/test is installed;
//   5. start `pnpm --filter @tc/web dev` with the fake switches and wait for /;
//   6. run Playwright (projects bn-360 and en-1280);
//   7. stop the server.
// Exit 0 only when every step passed. A missing package, browser, port or database prints BLOCKED with
// the exact commands and exits non-zero (3): a skipped proof is a failed proof, never a pass.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  SMOKE_ORIGIN,
  STATUS,
  blockedHelp,
  childEnv,
  classifyPlaywright,
  exitCodeFor,
  summaryLine,
} from "./lib/auth-smoke.mjs";

const root = resolve(import.meta.dirname, "..");
const START_LIMIT_MS = 30_000;
const PLAYWRIGHT_LIMIT_MS = 1_500_000;
const results = [];
let secrets = [];
const say = (line) => process.stdout.write(`${line}\n`);
function record(step, status, detail = "") {
  results.push({ step, status });
  say(summaryLine(step, status, detail, secrets));
}

// ---- children: every one is killed on exit, on error and on SIGINT -------------------------------

const children = new Set();
function killChild(child) {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process is gone already.
  }
}
function killAll() {
  for (const child of children) killChild(child);
  children.clear();
}
process.on("exit", killAll);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    killAll();
    process.exit(130);
  });
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const state = { child, output: "", exited: false, spawnError: null };
  child.stdout.on("data", (chunk) => (state.output += chunk));
  child.stderr.on("data", (chunk) => (state.output += chunk));
  child.on("error", (error) => {
    state.spawnError = error.message;
    state.exited = true;
  });
  child.on("close", () => {
    state.exited = true;
    children.delete(child);
  });
  return state;
}

async function run(command, args, env, limitMs) {
  const state = start(command, args, env);
  const done = new Promise((done) => {
    state.child.on("close", (code) => done(code));
    state.child.on("error", () => done(null));
  });
  const code = await Promise.race([
    done,
    sleep(limitMs).then(() => {
      killChild(state.child);
      return "timeout";
    }),
  ]);
  return { code, output: state.spawnError ?? state.output };
}

async function waitForServer(state) {
  const until = Date.now() + START_LIMIT_MS;
  while (Date.now() < until) {
    if (state.exited) return false;
    try {
      const response = await globalThis.fetch(`${SMOKE_ORIGIN}/`, {
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(3000),
      });
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

// ---- the steps ------------------------------------------------------------------------------------

async function main() {
  const skipSeed = process.argv.includes("--skip-seed");

  // 1. The guards.
  let child;
  try {
    child = childEnv(process.env);
  } catch (error) {
    record("guards", STATUS.FAIL, error instanceof Error ? error.message : "refused");
    return;
  }
  secrets = child.secrets;
  record("guards", STATUS.PASS, "local stage, local database, fake switches in the child only");

  // 2 and 3. The database, and the seed.
  const seedArgs = ["scripts/seed-auth-smoke.mjs", ...(skipSeed ? ["--check-only"] : [])];
  const seed = await run("node", seedArgs, process.env, 60_000);
  if (seed.code === 2) {
    record("database", STATUS.BLOCKED, blockedHelp("database"));
    return;
  }
  if (seed.code !== 0) {
    record("database", STATUS.FAIL, seed.output.trim().split("\n").at(-1) ?? "");
    return;
  }
  record("database", STATUS.PASS, seed.output.trim().split("\n").at(-1) ?? "");
  record(
    "seed",
    skipSeed ? STATUS.PASS : STATUS.PASS,
    skipSeed ? "skipped (--skip-seed)" : "market BD active",
  );

  // 4. Playwright must be installed before a server is started.
  const need = createRequire(import.meta.url);
  try {
    need.resolve("@playwright/test");
  } catch {
    record(
      "playwright",
      STATUS.BLOCKED,
      `@playwright/test is not installed; ${blockedHelp("playwright")}`,
    );
    return;
  }
  record("playwright", STATUS.PASS, "@playwright/test is installed");

  // 5. The server.
  const server = start("pnpm", ["--filter", "@tc/web", "dev"], child.env);
  const up = await waitForServer(server);
  if (!up) {
    const refused = /EPERM|EACCES|EADDRINUSE|listen/i.test(server.output);
    record(
      "server",
      refused ? STATUS.BLOCKED : STATUS.FAIL,
      refused ? blockedHelp("port") : "the app did not answer on /",
    );
    return;
  }
  record("server", STATUS.PASS, `answers on ${SMOKE_ORIGIN}`);

  // 6. The browser run. The spec writes the landing URL of each project into this folder.
  const out = mkdtempSync(join(tmpdir(), "auth-smoke-"));
  try {
    const playwright = await run(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "-c",
        "tests/e2e/playwright.config.ts",
        "tests/e2e/auth.spec.ts",
      ],
      { ...child.env, AUTH_SMOKE_OUT: out },
      PLAYWRIGHT_LIMIT_MS,
    );
    const verdict =
      playwright.code === "timeout"
        ? "fail"
        : classifyPlaywright(playwright.output, playwright.code);
    if (verdict === "blocked") {
      record(
        "browser",
        STATUS.BLOCKED,
        `a browser could not be started; ${blockedHelp("playwright")}`,
      );
    } else if (verdict === "pass") {
      record("browser", STATUS.PASS, "bn-360 and en-1280");
      for (const project of ["bn-360", "en-1280"]) {
        const file = join(out, `${project}.txt`);
        if (existsSync(file)) say(`landing ${project}: ${readFileSync(file, "utf8").trim()}`);
      }
    } else {
      record("browser", STATUS.FAIL, playwright.output.trim().split("\n").slice(-12).join(" | "));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  record("runner", STATUS.FAIL, error instanceof Error ? error.message : "unexpected error");
} finally {
  killAll();
  say(summaryLine("server stopped", STATUS.PASS));
}

const code = exitCodeFor(results);
say(code === 0 ? "auth-smoke: all steps passed" : `auth-smoke: not passed (exit ${code})`);
process.exit(code);
