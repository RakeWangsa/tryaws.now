// node scripts/smoke-apps.mjs [--app web|admin] [--skip-build]
// WPU-T4 Task 10: build both apps, read the route table, scan the output, start `next start`, read
// the headers and the HTML of the pages, and prove that /dev/ui is a 404 on the production stage.
// Exit 0 only when every step passed. A step that cannot run (port refused, timeout) fails (R16).
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { checkHtml, checkNoFakeInBundle, checkRouteTable } from "./lib/app-checks.mjs";
import { THEME_STYLESHEETS, themeAttributes } from "../packages/ui/theme/public.ts";

const say = (line) => process.stdout.write(`${line}\n`);
const APPS = ["web", "admin"];
const START_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 20_000;
const BUILD_LIMIT_MS = 600_000;
// `localhost`, never `127.0.0.1`: Next 16.4.6 builds the origin of its router from `--hostname` as it
// is, but `NextURL` turns every `127.x.x.x` into `localhost`, so the rewrite of the proxy (`/` to
// `/bn`) looks like an external rewrite, is fetched again and is answered by the redirect of `/bn`
// to `/` (a self-redirect). `localhost` and `0.0.0.0` are consistent (JOURNEY: WPU-T4 proxy fix).
const HOSTNAME = "localhost";
const root = resolve(import.meta.dirname, "..");

// ---- children: every one is killed on exit, on error and on SIGINT ------------------------------

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
process.on("uncaughtException", (error) => {
  killAll();
  process.stderr.write(
    `smoke-apps: unexpected error: ${error instanceof Error ? error.message : "?"}\n`,
  );
  process.exit(1);
});

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
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

// Runs a command to its end (or its limit) and returns { code, output }.
async function run(command, args, limitMs = BUILD_LIMIT_MS) {
  const state = start(command, args, {});
  const done = new Promise((resolve) => {
    state.child.on("close", (code) => resolve(code));
    state.child.on("error", () => resolve(null));
  });
  const code = await Promise.race([
    done,
    sleep(limitMs).then(() => {
      killChild(state.child);
      return "timeout";
    }),
  ]);
  if (state.spawnError !== null) return { code: null, output: state.spawnError };
  return { code, output: state.output };
}

// ---- results -------------------------------------------------------------------------------------

const results = [];

function record(app, step, problems) {
  const passed = problems.length === 0;
  results.push({ app, step, passed });
  say(`${passed ? "PASS" : "FAIL"} ${app}: ${step}`);
  for (const problem of problems.slice(0, 20)) say(`       - ${problem}`);
  if (problems.length > 20) say(`       - ... and ${problems.length - 20} more`);
}

// ---- http ----------------------------------------------------------------------------------------

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The admin app answers 403 to an address outside its allowlist (WP8-T1, 6.2): the smoke run starts
// it with this documentation range as the list and sends a CloudFront header from inside it.
const SMOKE_VIEWER = "203.0.113.5:44321";
const SMOKE_ALLOWLIST = "203.0.113.0/24";

async function get(base, path, init = {}) {
  const response = await globalThis.fetch(`${base}${path}`, {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(REQUEST_LIMIT_MS),
    ...init,
    headers: { "CloudFront-Viewer-Address": SMOKE_VIEWER, ...init.headers },
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

async function startServer(app, env) {
  const port = await freePort();
  const state = start(
    "pnpm",
    [
      "--filter",
      `@tc/${app}`,
      "exec",
      "next",
      "start",
      "--hostname",
      HOSTNAME,
      "--port",
      String(port),
    ],
    { PORT: String(port), ...env },
  );
  const base = `http://${HOSTNAME}:${port}`;
  const until = Date.now() + START_LIMIT_MS;
  for (;;) {
    if (state.exited) {
      killChild(state.child);
      throw new Error(`next start exited before it answered: ${state.output.slice(-300)}`);
    }
    if (Date.now() > until) {
      killChild(state.child);
      throw new Error(`next start did not answer within ${START_LIMIT_MS / 1000} s`);
    }
    try {
      await get(base, "/");
      return { base, stop: () => killChild(state.child) };
    } catch {
      await sleep(250);
    }
  }
}

// ---- the pages of one app ------------------------------------------------------------------------

function pagesOf(app) {
  const demos = app === "web" ? ["app", "public", "auth"] : ["admin"];
  // The home of the admin app needs a session and redirects to the sign-in; the sign-in is its open page.
  const home = app === "admin" ? "/login" : "/";
  return [
    { path: home, locale: "bn", headers: { "Accept-Language": "en" } },
    { path: app === "admin" ? "/en/login" : "/en", locale: "en" },
    { path: "/dev/ui", locale: "bn" },
    { path: "/en/dev/ui", locale: "en" },
    ...demos.map((demo) => ({ path: `/dev/ui/${demo}`, locale: "bn" })),
  ];
}

async function liveChecks(app, base) {
  const problems = [];
  const expectFor = (locale) => ({
    app,
    locale,
    stylesheets: [...THEME_STYLESHEETS],
    bodyAttributes: { ...themeAttributes(app) },
  });
  const attempt = async (label, work) => {
    try {
      problems.push(...(await work()).map((p) => `${label}: ${p}`));
    } catch (error) {
      problems.push(
        `${label}: could not complete (${error instanceof Error ? error.message : "?"})`,
      );
    }
  };

  for (const page of pagesOf(app)) {
    await attempt(page.path, async () => {
      const r = await get(base, page.path, { headers: page.headers });
      const where = r.headers.get("location");
      const own =
        r.status === 200
          ? []
          : [
              `status ${r.status}${where === null ? "" : ` to ${where}`}, expected 200 (no redirect)`,
            ];
      return [...own, ...checkHtml(r.text, r.headers, expectFor(page.locale))];
    });
  }
  await attempt("POST /api/csp-report", async () => {
    const body = JSON.stringify({
      "csp-report": { "document-uri": `${base}/`, "violated-directive": "script-src" },
    });
    const r = await get(base, "/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body,
    });
    return r.status === 204 ? [] : [`status ${r.status}, expected 204`];
  });
  await attempt("/bn", async () => {
    const r = await get(base, "/bn");
    const location = r.headers.get("location");
    const target = location === null ? null : location.replace(/^https?:\/\/[^/]+/, "");
    return [301, 302, 307, 308].includes(r.status) && target === "/"
      ? []
      : [`status ${r.status}, location ${String(location)}, expected a redirect to /`];
  });
  await attempt("missing path", async () => {
    const r = await get(base, "/this-path-does-not-exist");
    const own = r.status === 404 ? [] : [`status ${r.status}, expected 404`];
    return [...own, ...checkHtml(r.text, r.headers, expectFor("bn"))];
  });
  return problems;
}

async function productionCheck(app, base) {
  const problems = [];
  for (const path of ["/dev/ui", "/en/dev/ui"]) {
    try {
      const r = await get(base, path);
      if (r.status !== 404) problems.push(`${path}: status ${r.status}, expected 404`);
    } catch (error) {
      problems.push(
        `${path}: could not complete (${error instanceof Error ? error.message : "?"})`,
      );
    }
  }
  return problems;
}

// ---- one app -------------------------------------------------------------------------------------

async function withServer(app, env, work) {
  let server;
  try {
    server = await startServer(app, env);
  } catch (error) {
    return [`server did not start: ${error instanceof Error ? error.message : "?"}`];
  }
  try {
    return await work(server.base);
  } finally {
    server.stop();
    await sleep(300);
  }
}

// The .js files below a folder, for the check that the client bundle holds no fake (WP2-T2).
function clientFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return clientFiles(path);
      return entry.name.endsWith(".js") ? [{ path, text: readFileSync(path, "utf8") }] : [];
    });
  } catch {
    return [];
  }
}

async function smokeApp(app, { skipBuild }) {
  if (skipBuild) {
    say(`SKIP ${app}: build and route table (--skip-build)`);
  } else {
    const build = await run("pnpm", ["--filter", `@tc/${app}`, "build"]);
    const buildProblems =
      build.code === 0
        ? checkRouteTable(build.output)
        : [`build ended with ${String(build.code)}: ${build.output.slice(-400)}`];
    record(app, "next build, every route is dynamic", buildProblems);
  }

  const diff = await run("git", ["diff", "--exit-code", "--", `apps/${app}/tsconfig.json`]);
  record(
    app,
    "tsconfig.json is unchanged by the build",
    diff.code === 0 ? [] : [`git diff ended with ${String(diff.code)}`],
  );

  const scan = await run("pnpm", [
    "theme:scan",
    `apps/${app}/public`,
    `apps/${app}/.next/static`,
    `apps/${app}/.next/server`,
  ]);
  const scanProblems = [];
  if (scan.code !== 0)
    scanProblems.push(`theme:scan ended with ${String(scan.code)}: ${scan.output.slice(-400)}`);
  else if (!/: 0 findings/.test(scan.output))
    scanProblems.push("theme:scan did not report 0 findings");
  record(app, "theme:scan reports zero findings", scanProblems);

  if (app === "web") {
    record(
      app,
      "no fake (identity provider, refresh port, dev outbox) in the client bundle",
      checkNoFakeInBundle(clientFiles(resolve(root, "apps/web/.next/static"))),
    );
  }

  record(
    app,
    "next start: pages, headers, CSP report, redirect, 404",
    await withServer(
      app,
      { TC_DEV_UI: "on", TC_STAGE: "", ADMIN_IP_ALLOWLIST: SMOKE_ALLOWLIST },
      (base) => liveChecks(app, base),
    ),
  );
  record(
    app,
    "TC_STAGE=production: /dev/ui is 404",
    await withServer(
      app,
      { TC_DEV_UI: "on", TC_STAGE: "production", ADMIN_IP_ALLOWLIST: SMOKE_ALLOWLIST },
      (base) => productionCheck(app, base),
    ),
  );
}

// ---- main ----------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { apps: APPS, skipBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--skip-build") options.skipBuild = true;
    else if (argv[i] === "--app" && APPS.includes(argv[i + 1])) options.apps = [argv[++i]];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const app of options.apps) await smokeApp(app, options);
  const failed = results.filter((r) => !r.passed);
  say(`\n${results.length - failed.length}/${results.length} steps passed`);
  return failed.length === 0 && results.length > 0 ? 0 : 1;
}

main()
  .then((code) => {
    killAll();
    process.exit(code);
  })
  .catch((error) => {
    killAll();
    process.stderr.write(
      `smoke-apps: ${error instanceof Error ? error.message : "unexpected error"}\n`,
    );
    process.exit(1);
  });
