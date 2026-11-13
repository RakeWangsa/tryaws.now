import { createMemoryQueue } from "@tc/core";
import type { OperationQueue, OrdersDeps } from "@tc/core";
import type { WebConfig } from "./config.ts";
import { writeLog } from "./log.ts";
import { queuePortFromEnv } from "./queue-port.ts";
import { linkedSecrets, type SecretSource } from "./secrets.ts";

// The composition of the order functions of F for apps/web. `productionDeps()` of @tc/core stays
// throwing (R16); this file is the wiring that task WP4-T7 owes (open point 2). Nothing here reads
// process.env: the environment, the secret port (the SST SDK by default, WPU-Z15) and the ports are
// parameters. The fake switch is the configuration's `fakes` flag, which config.ts allows only in the
// stages local and test (R16), and it is checked against the stage a second time here.

const MIN_SECRET_BYTES = 32;

/** The fallback when no queue URL is configured (R1: the web tier does not import packages/aws). */
const SCHEDULER_ONLY_QUEUE: OperationQueue = {
  async send() {
    // Refuses on purpose: sendAfterCommit catches this and logs, and the scheduler sends the
    // message of an operation row whose enqueue_seq is still 0 (3.4). See JOURNEY.md, needs decision.
    throw new Error("orders: no queue client in the web tier");
  },
};

export interface OrdersPorts {
  readonly run: OrdersDeps["run"];
  readonly clock: OrdersDeps["clock"];
}

const FAKE_SECRET_KEY = "__tcFakeDraftSecret";

function fakeSecret(): Uint8Array {
  // Cached so that a hot reload does not invalidate the drafts of a developer's session.
  const holder = globalThis as unknown as Record<string, Uint8Array | undefined>;
  holder[FAKE_SECRET_KEY] ??= crypto.getRandomValues(new Uint8Array(MIN_SECRET_BYTES));
  return holder[FAKE_SECRET_KEY];
}

/** The dependencies of `makeOrders`, or null when the draft secret is not available (fail closed). */
export function assembleOrdersDeps(
  config: WebConfig,
  env: Readonly<Record<string, string | undefined>>,
  ports: OrdersPorts,
  secrets: SecretSource = linkedSecrets(),
): OrdersDeps | null {
  const log = (event: { event: string }): void => writeLog({ ...event });
  if (config.fakes) {
    if (config.stage !== "local" && config.stage !== "test") return null;
    return {
      ...ports,
      secrets: [fakeSecret()],
      queue: createMemoryQueue({ clock: ports.clock }),
      log,
    };
  }
  const text = secrets("OrderDraftSecret");
  if (text === undefined) return null;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < MIN_SECRET_BYTES) return null;
  // WPU-G2: the SQS port when the queue URL is configured (the function role holds sqs:SendMessage
  // only); otherwise the sweep carries every operation. A failed send never fails the order.
  const queue = queuePortFromEnv(env) ?? SCHEDULER_ONLY_QUEUE;
  return { ...ports, secrets: [bytes], queue, log };
}
