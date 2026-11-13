// WPU-Z10 (requirement 2): one week of logs on every log group a staging stage creates. Production and
// personal stages are unchanged: nothing is registered for them.
//
// The functions of functions/ set their retention themselves (workers.ts, workerLogRetention). The other
// log groups belong to functions that SST components build inside themselves: the Next.js server and
// image optimizer (SST 4.17.2 ssr-site.ts: image optimizer "3 days"), the ISR revalidation functions
// (nextjs.ts), the queue subscriber and cron functions, and the Cognito trigger (auth.ts). All of them are
// sst.aws.Function components, and `$transform(sst.aws.Function, ...)` changes the arguments of every
// sst.aws.Function created after it (SST 4.17.2 component.ts: ComponentTransforms run in the Component
// constructor, before the function reads `logging`). So infra/app.ts calls this before any stack.
// Each SST function creates its own aws.cloudwatch.LogGroup with retentionInDays from `logging.retention`
// (function.ts createLogGroup, logging.ts RETENTION: "1 week" is 7 days).
//
// Left as they are: `logging: false` (no log group) and `logging.logGroup` (a group made elsewhere: SST
// refuses retention together with logGroup). SST's Lambda@Edge signer (oac-with-edge-signing in web.ts) writes log groups that Lambda itself creates in edge Regions; this transform cannot reach them (docs/runbooks/staging-on-demand.md, 'Left behind').
// VERIFY (first `sst diff --stage staging`): every /aws/lambda log group of the stage shows
// retentionInDays 7.
//
// NOT TYPE-CHECKED, see network.ts.
import { componentLogRetention } from "../lib/lean";
import type { StageConfig } from "../lib/stage";

export function logRetention(config: StageConfig) {
  const retention = componentLogRetention(config.kind);
  if (retention === undefined) return;
  $transform(sst.aws.Function, (args) => {
    args.logging = $output(args.logging).apply((logging) =>
      logging === false || logging?.logGroup !== undefined
        ? logging
        : { ...(logging ?? {}), retention },
    );
  });
}
