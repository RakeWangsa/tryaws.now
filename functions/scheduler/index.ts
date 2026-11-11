import { QUEUE_URL_PATTERN, createSqsClient, createSqsSend } from "@tc/aws";
import {
  createFifoQueue,
  runLifecycle,
  runMetering,
  sweepOperations,
  type LifecycleReport,
  type MeteringReport,
  type LogEvent,
  type Logger,
  type SweepDeps,
  type SweepReport,
} from "@tc/core";
import { purgeRateLimits, withTx } from "@tc/db";

// Longest rate-limit window is 86400 s (packages/db rate-limit): a window that started two days ago is over.
export const RATE_LIMIT_RETENTION_MS = 2 * 86_400_000;

export interface SchedulerReport {
  readonly sweep: SweepReport | null;
  readonly lifecycle: LifecycleReport | null;
  readonly metering: MeteringReport | null;
  readonly rateLimitsPurged: number | null;
}

// Every run does the jobs of 3.2 in order: the operations sweep, the lifecycle pass (section
// 11), the metering pass (WP7-T5) and the purge of old rate-limit windows. One failing job does not stop the others; the run
// then rejects, so the error metric of the function moves (R16).
export function createHandler(deps: SweepDeps & { log: Logger }): () => Promise<SchedulerReport> {
  return async () => {
    let sweep: SweepReport | null = null;
    let lifecycle: LifecycleReport | null = null;
    let metering: MeteringReport | null = null;
    let rateLimitsPurged: number | null = null;
    const failed: string[] = [];
    const job = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        failed.push(name);
        deps.log({
          event: "scheduler_job_failed",
          job: name,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    };
    await job("sweep", async () => {
      sweep = await sweepOperations(deps);
      deps.log({ event: "sweep", ...sweep });
    });
    await job("lifecycle", async () => {
      lifecycle = await runLifecycle({
        runTx: deps.runTx,
        clock: deps.clock,
        queue: deps.queue,
        log: deps.log,
      });
      deps.log({ event: "lifecycle_run", ...lifecycle });
    });
    await job("metering", async () => {
      metering = await runMetering({ runTx: deps.runTx, clock: deps.clock, log: deps.log });
      deps.log({ event: "metering_run", ...metering });
      // A row that failed makes the run reject (R16); a missing price is only reported in the log line.
      if (metering.failed > 0) throw new Error("scheduler: metering rows failed");
    });
    await job("rate_limits", async () => {
      const before = new Date(deps.clock.now().getTime() - RATE_LIMIT_RETENTION_MS);
      rateLimitsPurged = await deps.runTx((tx) => purgeRateLimits(tx, before));
      deps.log({ event: "rate_limits_purged", count: rateLimitsPurged });
    });
    if (failed.length > 0) throw new Error(`scheduler: ${failed.join(", ")} failed`);
    return { sweep, lifecycle, metering, rateLimitsPurged };
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
let inner: (() => Promise<SchedulerReport>) | undefined;

export const handler = async (): Promise<SchedulerReport> => {
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
