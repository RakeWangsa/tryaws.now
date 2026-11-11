import { QUEUE_URL_PATTERN, createSqsClient, createSqsSend } from "@tc/aws";
import {
  createFifoQueue,
  sweepOperations,
  type LogEvent,
  type Logger,
  type SweepDeps,
  type SweepReport,
} from "@tc/core";
import { withTx } from "@tc/db";

// The lifecycle part of the scheduler (WP5-T4) is added to this handler later.
export function createHandler(deps: SweepDeps & { log: Logger }): () => Promise<SweepReport> {
  return async () => {
    const report = await sweepOperations(deps);
    deps.log({ event: "sweep", ...report });
    return report;
  };
}

// Fail closed (R16): the message names the variable and never its value (R3, R14). TC_ENV is not read.
export function readConfig(env: Record<string, string | undefined>): {
  readonly queueUrl: string;
  readonly region: string;
} {
  const bad = (name: string): Error => new Error(`scheduler: ${name} is missing or invalid`);
  const queueUrl = env.PROVISIONING_QUEUE_URL;
  if (typeof queueUrl !== "string" || !QUEUE_URL_PATTERN.test(queueUrl)) {
    throw bad("PROVISIONING_QUEUE_URL");
  }
  const region = env.AWS_REGION;
  if (typeof region !== "string" || region === "") throw bad("AWS_REGION");
  return { queueUrl, region };
}

// Built on the first call, not at import; a failed build keeps nothing.
let inner: (() => Promise<SweepReport>) | undefined;

export const handler = async (): Promise<SweepReport> => {
  if (inner === undefined) {
    const config = readConfig(process.env);
    inner = createHandler({
      runTx: withTx,
      clock: { now: () => new Date() },
      queue: createFifoQueue(createSqsSend(createSqsClient(config.region), config.queueUrl)),
      log: (e: LogEvent) => console.log(JSON.stringify(e)),
    });
  }
  return inner();
};
