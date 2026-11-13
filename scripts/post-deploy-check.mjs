// WP0-T6. Read-only check after a production deploy. It reads the SST outputs file and nothing else:
// no network, no AWS call, no other file. Run by .github/workflows/deploy-production.yml as the last step.
//
//   node scripts/post-deploy-check.mjs --stage production [--outputs .sst/outputs.json]
//
// Exit codes: 0 all assertions hold, 1 an assertion failed, 2 BLOCKED (the input to decide is missing).
// R16: a check that cannot complete is a failure, never a pass.
//
// Input keys the SST app must output (names only, never a secret value). infra/app.ts has to
// output them since WPU-D2 (infra/app.ts: featureFlagDefaults, webRolePolicies from infra/stacks/web.ts).
//   stage                string, must equal --stage
//   featureFlagDefaults  object, flag key -> boolean. R12: every default is false in production.
//   webRolePolicies      array of IAM policy documents (objects or JSON strings) attached to the web role
//                        and the admin role. R1: none allows sts:AssumeRole (or sts:*, or *).
//   smsConfigured        boolean (WPU-Y5 (a)), true when both SMS secrets are set (not the placeholder). Only a
//                        boolean, never a secret value. Production fails when it is not true: production must
//                        not run with SMS off unnoticed. Other stages do not need it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_BLOCKED = 2;

// The twelve product-family flags (FEATURE_FLAG_KEYS of packages/db). This script imports nothing but
// node:fs and node:url, so the list is a copy; tests/repo/infra-lib.test.mjs compares it with the source.
export const FEATURE_FLAG_KEYS = [
  "linux_instance",
  "static_ip",
  "backup",
  "disk",
  "windows_instance",
  "database",
  "load_balancer",
  "bucket",
  "container_service",
  "cdn",
  "dns_zone",
  "domain",
];

const STS_ASSUME = /^(\*|sts:\*|sts:assume[a-z]*)$/i;

function asList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseDocument(document) {
  if (typeof document === "string") {
    try {
      return JSON.parse(document);
    } catch {
      return undefined;
    }
  }
  return document !== null && typeof document === "object" ? document : undefined;
}

// Returns the list of problems with the policy documents. An unreadable document is a problem (R16).
export function assumeRoleProblems(policies) {
  const problems = [];
  policies.forEach((raw, index) => {
    const document = parseDocument(raw);
    if (!document || typeof document !== "object") {
      problems.push(`web role policy ${index} is not a readable policy document`);
      return;
    }
    for (const statement of asList(document.Statement)) {
      if (!statement || typeof statement !== "object") {
        problems.push(`web role policy ${index} has a statement that is not an object`);
        continue;
      }
      if (statement.Effect !== "Allow") continue;
      // NotAction with Allow grants everything but the listed actions, so it can include sts:AssumeRole.
      if (statement.NotAction !== undefined) {
        problems.push(`web role policy ${index} allows with NotAction`);
        continue;
      }
      const actions = asList(statement.Action);
      if (actions.some((action) => typeof action !== "string" || STS_ASSUME.test(action))) {
        problems.push(
          `web role policy ${index} allows sts:AssumeRole (or a wildcard that includes it)`,
        );
      }
    }
  });
  return problems;
}

export function flagProblems(defaults) {
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
    return ["featureFlagDefaults is not an object"];
  }
  const keys = Object.keys(defaults);
  if (keys.length === 0) return ["featureFlagDefaults is empty"];
  // R16: an output that leaves a product family out cannot show that it is off.
  const missing = FEATURE_FLAG_KEYS.filter((key) => !keys.includes(key)).map(
    (key) => `feature flag ${key} is missing from featureFlagDefaults`,
  );
  return [
    ...missing,
    ...keys
      .filter((key) => defaults[key] !== false)
      .map((key) => `feature flag ${key} is not false`),
  ];
}

// result: { code, lines } and no side effect, so a test can call it.
export function checkOutputs({ stage, outputsText }) {
  if (typeof outputsText !== "string") {
    return { code: EXIT_BLOCKED, lines: ["BLOCKED: the SST outputs file is not available"] };
  }
  let outputs;
  try {
    outputs = JSON.parse(outputsText);
  } catch {
    return { code: EXIT_BLOCKED, lines: ["BLOCKED: the SST outputs file is not JSON"] };
  }
  if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
    return { code: EXIT_BLOCKED, lines: ["BLOCKED: the SST outputs are not an object"] };
  }
  const missing = ["featureFlagDefaults", "webRolePolicies"].filter(
    (key) => outputs[key] === undefined,
  );
  if (missing.length > 0) {
    return {
      code: EXIT_BLOCKED,
      lines: [
        `BLOCKED: the SST outputs lack ${missing.join(" and ")}; the stacks must output them`,
      ],
    };
  }
  if (stage === "production" && outputs.smsConfigured === undefined) {
    return {
      code: EXIT_BLOCKED,
      lines: ["BLOCKED: the SST outputs lack smsConfigured; the stacks must output it"],
    };
  }
  const problems = [];
  if (outputs.stage !== stage)
    problems.push(`outputs are for stage ${String(outputs.stage)}, not ${stage}`);
  problems.push(...flagProblems(outputs.featureFlagDefaults));
  // The web role and the admin role: one policy document each at least (infra/stacks/web.ts).
  if (!Array.isArray(outputs.webRolePolicies) || outputs.webRolePolicies.length < 2) {
    problems.push("webRolePolicies is not an array of at least two policy documents");
  } else {
    problems.push(...assumeRoleProblems(outputs.webRolePolicies));
  }
  if (stage === "production" && outputs.smsConfigured !== true) {
    problems.push(
      "SMS is not configured in production (smsConfigured is not true): set SmsApiKey and SmsSenderId (docs/runbooks/sms-gateway.md)",
    );
  }
  if (problems.length > 0) return { code: EXIT_FAILED, lines: problems.map((p) => `FAILED: ${p}`) };
  return {
    code: EXIT_OK,
    lines: [
      `OK: every feature flag default is off in ${stage}`,
      "OK: no web or admin role policy allows sts:AssumeRole",
      ...(stage === "production" ? ["OK: SMS is configured in production"] : []),
    ],
  };
}

function parseArgs(argv) {
  const args = { stage: undefined, outputs: ".sst/outputs.json" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--stage") args.stage = argv[(i += 1)];
    else if (argv[i] === "--outputs") args.outputs = argv[(i += 1)];
    else return undefined;
  }
  return args.stage ? args : undefined;
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    return {
      code: EXIT_BLOCKED,
      lines: ["BLOCKED: usage: post-deploy-check.mjs --stage <stage> [--outputs <file>]"],
    };
  }
  let outputsText;
  try {
    outputsText = readFileSync(args.outputs, "utf8");
  } catch {
    outputsText = undefined;
  }
  return checkOutputs({ stage: args.stage, outputsText });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, lines } = main(process.argv.slice(2));
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = code;
}
