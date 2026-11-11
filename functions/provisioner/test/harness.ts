import { createManualClock, createMemoryQueue, type LogEvent, type QueueMessage } from "@tc/core";
import { useTempDatabase } from "@tc/db/testing";
import { beforeAll } from "vitest";
import { createAdapterRegistry } from "../adapters";
import type { StepDeps } from "../types";
import { createFakeCloud, fakeAccess, fakeInstanceAdapter } from "./fakes";
import { seedOperation, seedResource, seedWorld, workerTx, type World } from "./seed";

export const NOW = new Date("2026-11-11T10:00:00.000Z");

export function useHarness() {
  const t = useTempDatabase();
  const world = {} as { -readonly [K in keyof World]: World[K] };
  beforeAll(async () => {
    Object.assign(world, await seedWorld(t.pool));
  });

  function setup(over: Partial<StepDeps> = {}) {
    const clock = createManualClock(NOW);
    const cloud = createFakeCloud();
    const queue = createMemoryQueue({ clock });
    const logged: LogEvent[] = [];
    const deps: StepDeps = {
      runTx: workerTx(t.db),
      clock,
      queue,
      adapters: createAdapterRegistry([fakeInstanceAdapter(cloud)]),
      access: fakeAccess(),
      env: "staging",
      log: (e) => logged.push(e),
      ...over,
    };
    return { clock, cloud, queue, logged, deps };
  }
  const message = (operationId: string, resourceId: string, enqueueSeq = 0): QueueMessage => ({
    operationId,
    resourceId,
    enqueueSeq,
  });
  const create = async (over: Record<string, unknown> = {}) => {
    const resourceId = await seedResource(t.pool, world);
    const id = await seedOperation(t.pool, resourceId, {
      kind: "create",
      payload: { orderId: world.orderId, note: "someone@example.test" },
      ...over,
    });
    return { resourceId, id };
  };
  const resourceRow = async (id: string) =>
    (await t.pool.query("select * from resources where id = $1", [id])).rows[0];
  return { t, world: world as World, setup, message, create, resourceRow };
}
