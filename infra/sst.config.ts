// The SST app of TiCON Cloud (WP0-T2, WP0-T3, WP0-T4). Nothing here deploys by itself: a deploy is
// `npx sst deploy --stage staging` by a person who was asked (CLAUDE.md), or the protected CI job.
//
// SST reads `sst.config.ts` at the repository root; the root file re-exports this one
// (VERIFY: the docs show no --config flag, so the re-export is the way to keep the code in infra/).
//
// The `/// <reference path=".sst/platform/config.d.ts" />` line that `sst init` adds is left out on purpose:
// the lint rule triple-slash-reference refuses it. Editors find the types once sst is installed.
//
// NOT TYPE-CHECKED: `sst` is not installed in this repository yet (JOURNEY.md, first manual step).
// The pure parts are in infra/lib/ and are type-checked and tested; the resource declarations are in
// infra/stacks/, linted and formatted only, with a repo test that reads their text.
import { featureFlagDefaults } from "./lib/functions";
import {
  assertDeployAllowed,
  readStageConfig,
  removalPolicy,
  REGION,
  stageKind,
} from "./lib/stage";

export default $config({
  app(input) {
    const stage = input?.stage ?? "";
    // Refuses production unless the protected CI job set the variable; refuses fake switches.
    assertDeployAllowed(stage, process.env);
    return {
      name: "ticon-cloud",
      home: "aws",
      // retain keeps the data stores of staging and production when a stage is removed.
      removal: removalPolicy(stage),
      protect: stageKind(stage) === "production",
      providers: { aws: { region: REGION } },
    };
  },
  async run() {
    const config = readStageConfig($app.stage, process.env);

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
  },
});
