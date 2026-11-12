// node scripts/smoke-a11y.mjs [--skip-seed] [--skip-admin]
// WPU-X6: the accessibility proof. Starts the web app (port 3000) and the admin app (port 3001) with the
// fake switches, runs Playwright with axe-core over the signed-out pages at 360 px and 1280 px in bn and
// en (tests/e2e/a11y.spec.ts), prints the violations per page, stops the servers.
// Steps, one summary line each: guards, database, playwright, servers, browser runs.
// Exit 0 only when every step passed. A missing package, browser, port or database prints BLOCKED with
// the exact commands and exits 3: a skipped proof is a failed proof, never a pass (as auth-smoke).
// The guards, the child environment and the reading of the Playwright output are those of auth-smoke.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  STATUS,
  blockedHelp,
  childEnv,
  classifyPlaywright,
  exitCodeFor,
  redact,
} from "./lib/auth-smoke.mjs";

const root = resolve(import.meta.dirname, "..");
const APPS = [
  { name: "web", filter: "@tc/web", origin: "http://localhost:3000" },
  { name: "admin", filter: "@tc/admin", origin: "http://localhost:3001" },
];
// Admin only (same placeholders as scripts/smoke-apps.mjs): the sign-in guard reads the admin pool
// settings first and refuses to start without them (R16); the allowlist is the documentation range.
const ADMIN_FAKE_ENV = {
  COGNITO_ADMIN_POOL_ID: "ap-southeast-1_SMOKEPOOL1",
  COGNITO_ADMIN_CLIENT_ID: "smokeclient1234567890",
  ADMIN_IP_ALLOWLIST: "203.0.113.0/24",
};
const START_LIMIT_MS = 60_000;
const PLAYWRIGHT_LIMIT_MS = 1_500_000;
const results = [];
let secrets = [];
const say = (line) => process.stdout.write(`${line}\n`);
function record(step, status, detail = "") {
  results.push({ step, status });
  say(`${status} a11y-smoke: ${step}${detail === "" ? "" : ` - ${redact(detail, secrets)}`}`);
}

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
  const done = new Promise((resolveDone) => {
    state.child.on("close", (code) => resolveDone(code));
    state.child.on("error", () => resolveDone(null));
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

async function waitForServer(state, origin) {
  const until = Date.now() + START_LIMIT_MS;
  while (Date.now() < until) {
    if (state.exited) return false;
    try {
      const response = await globalThis.fetch(`${origin}/`, {
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

/** One line per page with a violation, from the JSON lines the spec appended. */
function violationLines(file) {
  if (!existsSync(file)) return [];
  const lines = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    const row = JSON.parse(raw);
    for (const v of row.found) {
      lines.push(
        `violation ${row.app} ${row.project} ${row.path}: ${v.id} (${v.impact}, ${v.nodes} nodes) ${v.targets.join(" | ")}`,
      );
    }
  }
  return lines;
}

async function main() {
  const skipSeed = process.argv.includes("--skip-seed");
  const skipAdmin = process.argv.includes("--skip-admin");

  // 1. The guards (R3): the local stage, a local database, the fake switches in the children only.
  let child;
  try {
    child = childEnv(process.env);
  } catch (error) {
    record("guards", STATUS.FAIL, error instanceof Error ? error.message : "refused");
    return;
  }
  secrets = child.secrets;
  record("guards", STATUS.PASS, "local stage, local database, fake switches in the child only");

  // 2. The database: the public pages read the catalog of the market.
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

  // 3. Playwright and axe must be installed before a server is started.
  const need = createRequire(import.meta.url);
  for (const name of ["@playwright/test", "@axe-core/playwright"]) {
    try {
      need.resolve(name);
    } catch {
      record("playwright", STATUS.BLOCKED, `${name} is not installed; run pnpm install`);
      return;
    }
  }
  record("playwright", STATUS.PASS, "@playwright/test and @axe-core/playwright are installed");

  const out = mkdtempSync(join(tmpdir(), "a11y-smoke-"));
  const outFile = join(out, "found.jsonl");
  try {
    for (const app of APPS) {
      if (app.name === "admin" && skipAdmin) continue;

      // 4. The server of this app.
      const env = {
        ...child.env,
        APP_ORIGIN: app.origin,
        ...(app.name === "admin" ? ADMIN_FAKE_ENV : {}),
      };
      const server = start("pnpm", ["--filter", app.filter, "dev"], env);
      const up = await waitForServer(server, app.origin);
      if (!up) {
        const refused = /EPERM|EACCES|EADDRINUSE|listen/i.test(server.output);
        record(
          `server ${app.name}`,
          refused ? STATUS.BLOCKED : STATUS.FAIL,
          refused
            ? blockedHelp("port")
            : `the app did not answer on ${app.origin}: ${server.output.trim().split("\n").slice(-3).join(" | ")}`,
        );
        killChild(server.child);
        continue;
      }
      record(`server ${app.name}`, STATUS.PASS, `answers on ${app.origin}`);

      // 5. The browser run of this app.
      const playwright = await run(
        "pnpm",
        ["exec", "playwright", "test", "-c", "tests/e2e/a11y.config.ts"],
        { ...env, A11Y_APP: app.name, A11Y_ORIGIN: app.origin, A11Y_OUT: outFile },
        PLAYWRIGHT_LIMIT_MS,
      );
      const verdict =
        playwright.code === "timeout"
          ? "fail"
          : classifyPlaywright(playwright.output, playwright.code);
      if (verdict === "blocked") {
        record(
          `browser ${app.name}`,
          STATUS.BLOCKED,
          `a browser could not be started; ${blockedHelp("playwright")}`,
        );
      } else if (verdict === "pass") {
        record(
          `browser ${app.name}`,
          STATUS.PASS,
          "bn-360, en-360, bn-1280, en-1280, no violation",
        );
      } else {
        record(
          `browser ${app.name}`,
          STATUS.FAIL,
          playwright.output.trim().split("\n").slice(-6).join(" | "),
        );
      }
      killChild(server.child);
      await sleep(1000);
    }
    for (const line of violationLines(outFile)) say(line);
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
}

const code = exitCodeFor(results);
say(code === 0 ? "a11y-smoke: all steps passed" : `a11y-smoke: not passed (exit ${code})`);
process.exit(code);
