// The SST app of TiCON Cloud (WP0-T2, WP0-T3, WP0-T4). Nothing here deploys by itself: a deploy is
// `npx sst deploy --stage staging` by a person who was asked (CLAUDE.md), or the protected CI job.
//
// SST reads `sst.config.ts` at the repository root. SST 4 refuses every static import in a file named
// sst.config.ts (pkg/js/js.go, esbuild plugin "DisallowImports": any command fails with "has top level
// imports"), so the root file holds no import and loads this module with `await import("./infra/app")`
// in both of its functions. This file must never be named sst.config.ts (the rule matches the file name).
// The environment is read only in the root file and handed in (tests/repo/infra-tooling.test.mjs).
//
// The `/// <reference path=".sst/platform/config.d.ts" />` line that `sst init` adds is left out on purpose:
// the lint rule triple-slash-reference refuses it. Editors find the types once sst is installed.
//
// NOT TYPE-CHECKED unless `.sst/platform/config.d.ts` exists (tests/repo/sst-types.test.mjs). The pure
// parts are in infra/lib/ and are type-checked and tested; the resource declarations are in infra/stacks/.
import { featureFlagDefaults } from "./lib/functions";
import {
  assertDeployAllowed,
  readStageConfig,
  removalPolicy,
  REGION,
  stageKind,
  type Env,
} from "./lib/stage";

// The `app` part of the SST config: called by the root sst.config.ts with the stage and the environment.
export function appConfig(stage: string, env: Env) {
  // Refuses production unless the protected CI job set the variable; refuses fake switches.
  assertDeployAllowed(stage, env);
  return {
    name: "ticon-cloud",
    // `as const`: without it the literal widens to string and the root config fails tsc against the SST
    // types (App.home is "aws" | "cloudflare" | "local").
    home: "aws" as const,
    // retain keeps the data stores of staging and production when a stage is removed.
    removal: removalPolicy(stage),
    protect: stageKind(stage) === "production",
    providers: { aws: { region: REGION } },
  };
}

// The `run` part of the SST config: called by the root sst.config.ts with the environment. The `sst`, `aws`
// and `$app` globals exist only here (SST injects them for run), never in appConfig.
export async function runApp(env: Env) {
  const config = readStageConfig($app.stage, env);

  // Dynamic imports: the stack files use the `sst` and `aws` globals, which exist only inside run().
  const { secrets } = await import("./stacks/secrets");
  const { network } = await import("./stacks/network");
  const { waf } = await import("./stacks/waf");
  const { storage } = await import("./stacks/storage");
  const { database } = await import("./stacks/database");
  const { messaging } = await import("./stacks/messaging");
  const { auth } = await import("./stacks/auth");
  const { workers } = await import("./stacks/workers");
  const { web } = await import("./stacks/web");
  const { alarms } = await import("./stacks/alarms");
  const { budget } = await import("./stacks/budget");

  const secretSet = secrets();
  const net = network(config);
  const edge = waf(config);
  const files = storage(config);
  const db = database(config, net, secretSet);
  const queues = messaging();
  const identity = auth(config);
  const fns = workers({
    config,
    net,
    db,
    secrets: secretSet,
    queues,
    storage: files,
  });
  const apps = web({
    config,
    net,
    db,
    secrets: secretSet,
    queues,
    storage: files,
    auth: identity,
    waf: edge,
    workers: fns,
  });
  const alarm = alarms(config, queues, fns, apps);
  // WPU-B8: the monthly budget alarm exists only on a lean stage; it needs the alarm topic.
  if (config.size === "lean") {
    budget(config, alarm.topic);
  }

  // Outputs listed by `sst deploy`; names only, never a secret value.
  return {
    stage: config.stage,
    webUrl: apps.customer.url,
    adminUrl: apps.admin.url,
    provisioningQueue: queues.provisioning.url,
    deadLetterQueue: queues.deadLetter.url,
    kycBucket: files.kyc.name,
    invoicesBucket: files.invoices.name,
    exportsBucket: files.exports.name,
    customerPoolId: identity.customers.id,
    adminPoolId: identity.admins.id,
    alarmTopic: alarm.topic.arn,
    // C.2: read by scripts/post-deploy-check.mjs after a production deploy. R12: every default is
    // false; R1: no policy of the web and admin roles allows sts:AssumeRole.
    featureFlagDefaults: featureFlagDefaults(),
    webRolePolicies: apps.webRolePolicies,
  };
}
