// node scripts/smoke-wallet.mjs [--skip-seed]
// WP3-T4 Task 8: the wallet proof against fakes. Seeds the LOCAL database, starts the dev server with
// the fake EPS, runs Playwright in two projects (bn-360 and en-1280), stops the server. Exit 0 only
// when every step passed. A step that cannot run is BLOCKED and exits 2: a skipped proof is a failed
// proof (R16, open point 8). The owner starts the database (`pnpm db:up && pnpm db:migrate`); this
// script never does, and refuses staging, production and any database that is not local (R3).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { APP_ORIGIN, SMOKE_PORT, blocked, parseTopUpLine, smokeEnv } from "./lib/wallet-smoke.mjs";

const root = resolve(import.meta.dirname, "..");
const say = (line) => process.stdout.write(`${line}\n`);
const SERVER_START_MS = 60_000;
const SPEC_LIMIT_MS = 600_000;
const PROJECTS = ["bn-360", "en-1280"];

const children = new Set();
function killAll() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
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
  const state = { child, output: "", exited: false, code: null };
  child.stdout.on("data", (chunk) => (state.output += chunk));
  child.stderr.on("data", (chunk) => (state.output += chunk));
  child.on("error", () => (state.exited = true));
  child.on("close", (code) => {
    state.exited = true;
    state.code = code;
    children.delete(child);
  });
  return state;
}

async function waitFor(state, done, limitMs) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if (done()) return true;
    if (state.exited) return done();
    await sleep(500);
  }
  return false;
}

function fail(step, why) {
  say(`FAIL ${step}: ${why}`);
  killAll();
  process.exit(1);
}

function stop(reasons) {
  for (const reason of reasons) say(blocked(reason));
  say("smoke-wallet: BLOCKED, so the wallet proof did not run");
  process.exit(2);
}

// ---- 1. the environment (R3) --------------------------------------------------------------------

const built = smokeEnv(process.env);
if (!built.ok) fail("environment", built.reason);
const env = built.env;
say("pass environment: stage local, fake EPS, local database");

// ---- 2. what must exist before anything starts ---------------------------------------------------

const blockedBy = [];
let playwright = null;
try {
  playwright = createRequire(resolve(root, "package.json"))("@playwright/test");
} catch {
  blockedBy.push("playwright");
}
if (playwright !== null) {
  try {
    if (!existsSync(playwright.chromium.executablePath())) blockedBy.push("browser");
  } catch {
    blockedBy.push("browser");
  }
}
const databaseUp = await (async () => {
  try {
    const pg = createRequire(resolve(root, "packages/db/package.json"))("pg");
    const client = new pg.Client({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
    });
    await client.connect();
    // The migrations are applied when the payments table exists.
    const { rows } = await client.query("select to_regclass('public.payments') as t");
    await client.end();
    return rows[0]?.t !== null;
  } catch {
    return false;
  }
})();
if (!databaseUp) blockedBy.push("database");
const portFree = await new Promise((done) => {
  const server = createServer();
  server.once("error", () => done(false));
  server.listen(SMOKE_PORT, "localhost", () => server.close(() => done(true)));
});
if (!portFree) blockedBy.push("port");
if (blockedBy.length > 0) stop(blockedBy);
say("pass prerequisites: Playwright, Chromium, database, port");

// ---- 3. the seed ---------------------------------------------------------------------------------

let seed = null;
if (!process.argv.includes("--skip-seed")) {
  const seeding = start("node", ["scripts/seed-wallet-smoke.ts"], env);
  await waitFor(seeding, () => seeding.exited, 30_000);
  const line = seeding.output.split("\n").find((l) => l.startsWith("{"));
  if (seeding.code !== 0 || line === undefined) fail("seed", "the seed did not finish");
  seed = JSON.parse(line);
  say("pass seed: 2 customers for the projects, 1 for the cross-tenant check");
} else {
  say("skip seed (--skip-seed): the subjects must be in WALLET_SMOKE_SUBS");
}

// ---- 4. the dev server ---------------------------------------------------------------------------

const server = start("pnpm", ["--filter", "@tc/web", "dev"], env);
const up = await waitFor(
  server,
  () => /Ready in|✓ Ready|Local:/.test(server.output),
  SERVER_START_MS,
);
if (!up) fail("server", "the dev server did not become ready in 60 s");
// The first request compiles the proxy and the page; wait for an answer, not for the log line.
let answered = false;
for (let i = 0; i < 40 && !answered; i++) {
  try {
    const response = await globalThis.fetch(`${APP_ORIGIN}/`, { redirect: "manual" });
    answered = response.status < 500;
  } catch {
    await sleep(1000);
  }
}
if (!answered) fail("server", "the dev server does not answer on /");
say(`pass server: ${APP_ORIGIN} answers`);

// ---- 5. Playwright -------------------------------------------------------------------------------

const specEnv = {
  ...env,
  WALLET_SMOKE_SUBS: JSON.stringify(
    seed?.subs ?? JSON.parse(process.env.WALLET_SMOKE_SUBS ?? "{}"),
  ),
  WALLET_SMOKE_OTHER_PAYMENT: seed?.otherPaymentId ?? process.env.WALLET_SMOKE_OTHER_PAYMENT ?? "",
  FORCE_COLOR: "0",
};
const spec = start(
  "pnpm",
  ["exec", "playwright", "test", "-c", "tests/e2e/playwright.config.ts"],
  specEnv,
);
await waitFor(spec, () => spec.exited, SPEC_LIMIT_MS);
const lines = spec.output
  .split("\n")
  .map(parseTopUpLine)
  .filter((found) => found !== null);
const seen = new Map(lines.map((found) => [found.project, found]));
for (const project of PROJECTS) {
  const found = seen.get(project);
  if (found === undefined) continue;
  say(
    `pass ${project}: balance ${found.balance}, ${found.ledger} ledger line, ${found.payments} payment, no horizontal scroll: ${found.noScroll}`,
  );
}
killAll();
if (spec.code !== 0) {
  say(spec.output.split("\n").slice(-40).join("\n"));
  fail("playwright", "the spec failed");
}
for (const project of PROJECTS) {
  const found = seen.get(project);
  if (found === undefined || found.ledger !== 1 || found.payments !== 1 || !found.noScroll) {
    fail("playwright", `the summary line of ${project} is missing or wrong`);
  }
}
say("smoke-wallet: all steps passed");
