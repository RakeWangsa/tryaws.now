import { createMemoryQueue } from "@tc/core";
import type { OperationQueue, OrdersDeps } from "@tc/core";
import type { WebConfig } from "./config.ts";
import { writeLog } from "./log.ts";
import { resourceSecrets } from "./secrets.ts";

// The composition of the order functions of F for apps/web. `productionDeps()` of @tc/core stays
// throwing (R16); this file is the wiring that task WP4-T7 owes (open point 2). Nothing here reads
// process.env: the environment and the ports are parameters. The fake switch is the configuration's
// `fakes` flag, which config.ts allows only in the stages local and test (R16), and it is checked
// against the stage a second time here.

const MIN_SECRET_BYTES = 32;

/** The web tier has no queue client of its own (R1: it does not import packages/aws). */
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
  const text = resourceSecrets(env)("OrderDraftSecret");
  if (text === undefined) return null;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < MIN_SECRET_BYTES) return null;
  return { ...ports, secrets: [bytes], queue: SCHEDULER_ONLY_QUEUE, log };
}
