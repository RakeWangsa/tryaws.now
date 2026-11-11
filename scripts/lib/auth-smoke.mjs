// Pure helpers of scripts/smoke-auth.mjs (WP2-T2 Task 10): the environment of the child process, the
// guards that keep the smoke on the local machine, and the reading of the Playwright output.
// Nothing here starts a process or opens a connection, so the unit tests need no browser, no port and
// no database. A secret is never put into a summary line: lines pass through redact().
import { randomBytes } from "node:crypto";

export const SMOKE_ORIGIN = "http://localhost:3000";
// Stub identifiers in the shape the pool variables must have; no pool of this name exists.
export const STUB_POOL_ID = "ap-southeast-1_SmokeStub0";
export const STUB_CLIENT_ID = "smokestubclient0000";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when the database URL names this machine (the tests of @tc/db apply the same rule). */
export function isLocalDatabaseUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  let parsed;
  try {
    parsed = new globalThis.URL(url);
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(parsed.hostname);
}

/**
 * The environment of the child that serves the app: the three fake switches, the local stage, stub
 * pool identifiers, and two generated keys that exist only in this process tree. Refuses staging and
 * production (R3) and a database that is not local. Returns the keys too, for redact().
 */
export function childEnv(parent, randomHex = () => randomBytes(32).toString("hex")) {
  const stage = parent.TC_STAGE;
  if (stage === "staging" || stage === "production") {
    throw new Error("smoke-auth: refuses TC_STAGE staging or production");
  }
  if (parent.NODE_ENV === "production") {
    throw new Error("smoke-auth: refuses NODE_ENV production");
  }
  const database = parent.DATABASE_URL;
  if (database !== undefined && database !== "" && !isLocalDatabaseUrl(database)) {
    throw new Error("smoke-auth: refuses a database that is not on this machine");
  }
  const limitKey = randomHex();
  const otpKey = randomHex();
  const secret = (value) => JSON.stringify({ type: "sst.sst.Secret", value });
  const env = {
    ...parent,
    TC_STAGE: "local",
    TC_EPS: "fake",
    TC_IDP: "fake",
    TC_SMS: "fake",
    APP_ORIGIN: SMOKE_ORIGIN,
    NODE_ENV: "development",
    COGNITO_CUSTOMER_POOL_ID: STUB_POOL_ID,
    COGNITO_CUSTOMER_CLIENT_ID: STUB_CLIENT_ID,
    SST_RESOURCE_AuthLimitKey: secret(limitKey),
    SST_RESOURCE_OtpHashKey: secret(otpKey),
  };
  return { env, secrets: [limitKey, otpKey, STUB_POOL_ID, STUB_CLIENT_ID] };
}

/** Replaces every secret in a line by "[hidden]". */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret !== "") out = out.split(secret).join("[hidden]");
  }
  return out;
}

export const STATUS = Object.freeze({ PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED" });

/** One summary line per step. */
export function summaryLine(step, status, detail = "", secrets = []) {
  const tail = detail === "" ? "" : ` - ${redact(detail, secrets)}`;
  return `${status} auth-smoke: ${step}${tail}`;
}

// What Playwright (or Node) prints when the package or its browser is missing.
const BLOCKED_PATTERNS = [
  /Executable doesn't exist/i,
  /browserType\.launch/i,
  /npx playwright install|playwright install/i,
  /Cannot find (?:module|package) ['"]?@?playwright/i,
  /ERR_MODULE_NOT_FOUND[^\n]*playwright/i,
  /Failed to launch/i,
  /Host system is missing dependencies/i,
];

/**
 * Reads the end of a Playwright run: "blocked" when the package or the browser is not there (a skipped
 * proof is a failed proof, never a pass), "pass" only for exit code 0 with a passed count, "fail" else.
 */
export function classifyPlaywright(output, exitCode) {
  const text = String(output);
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(text))) return "blocked";
  if (exitCode === 0 && /\b[1-9]\d* passed\b/.test(text) && !/\bfailed\b/.test(text)) return "pass";
  return "fail";
}

/** The exit code of the runner: 0 only when every step passed. BLOCKED is not 0. */
export function exitCodeFor(results) {
  if (results.length === 0) return 1;
  if (results.some((r) => r.status === STATUS.FAIL)) return 1;
  if (results.some((r) => r.status === STATUS.BLOCKED)) return 3;
  return 0;
}

export const BLOCKED_HELP = Object.freeze({
  playwright:
    "install the pinned dev dependency and the browser: pnpm add -D -w @playwright/test@<exact version> && pnpm exec playwright install chromium",
  database: "start and migrate the local database: pnpm db:up && pnpm db:migrate",
  port: "allow the local port in the sandbox: sandbox.network.allowLocalBinding: true",
});

/** The commands to run, printed with a BLOCKED line. */
export function blockedHelp(kind) {
  return BLOCKED_HELP[kind] ?? "";
}

/**
 * The Bengali digits of a number, for the test that types a code in Bengali.
 * ("123456" -> "১২৩৪৫৬")
 */
export function toBengaliDigits(text) {
  const digits = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
  return String(text).replace(/[0-9]/g, (d) => digits[Number(d)]);
}
