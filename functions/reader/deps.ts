import { createAwsAccess, createLightsailReadSource } from "@tc/aws";
import type { Clock, Logger } from "@tc/core";
import { loadReadTarget, type ReadCaller, type Tx } from "@tc/db";
import type { ReaderConfig } from "./config";
import { createReader, type Reader } from "./handler";
import { createInvoke } from "./invoke";

export interface ReaderEnv {
  readonly config: ReaderConfig;
  readonly clock: Clock;
  readonly runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly log: Logger;
}

// Assembles the reader from values handed in: no environment access, no global clock. The tenant
// check runs in its own short transaction, and AWS is never called inside a transaction.
export function buildReaderDeps(env: ReaderEnv): {
  reader: Reader;
  handler: ReturnType<typeof createInvoke>;
} {
  const access = createAwsAccess({ caller: "reader", clock: env.clock });
  const reader = createReader({
    loadTarget: (caller: ReadCaller, resourceId: string) =>
      env.runTx((tx) => loadReadTarget(tx, caller, resourceId)),
    source: createLightsailReadSource(access, env.clock),
    clock: env.clock,
    log: env.log,
    rateLimit: env.config.rateLimit,
  });
  return { reader, handler: createInvoke(reader) };
}
