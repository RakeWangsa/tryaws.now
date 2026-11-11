import {
  checkStepResult,
  OPERATION_KINDS,
  stepDone,
  stepNext,
  stepWait,
  type OperationKind,
} from "@tc/core";
import { expect, it } from "vitest";
import type { LiveState, OpCtx, ProductAdapter } from "../adapters/types";

interface Config {
  readonly plan: string;
}

const adapter: ProductAdapter<Config> = {
  family: "linux_instance",
  parseConfig: (input) => ({ plan: String((input as { plan?: unknown }).plan) }),
  aws: {
    create: async (ctx) =>
      ctx.operation.step === null ? stepNext("wait_running") : stepDone({ state: "active" }),
    suspend: async () => stepDone(),
    resume: async () => stepDone(),
    finalSnapshot: async () => stepWait("snapshot_pending", new Date()),
    destroy: async () => stepDone({ state: "destroyed" }),
    purgeSnapshots: async () => stepDone(),
    describe: async (ctx: OpCtx<Config>): Promise<LiveState> => ({ state: ctx.config.plan }),
    action: async (kind: OperationKind) => (kind === "reboot" ? stepDone() : stepNext("later")),
  },
};

const NOW = new Date("2030-01-01T00:00:00.000Z");
const ctx: OpCtx<Config> = {
  operation: { id: "o-1", kind: "create", step: null, attempt: 1, createdAt: NOW, payload: {} },
  stepKey: "o-1:start",
  resource: {
    id: "r-1",
    customerId: "c-1",
    family: "linux_instance",
    productId: null,
    parentResourceId: null,
    awsName: null,
    state: "creating",
    config: {},
  },
  config: { plan: "nano" },
  account: { awsAccountId: "123456789012", externalId: "ext-1" },
  region: "ap-southeast-1",
  access: {
    caller: "provisioner",
    lightsail: () => {
      throw new Error("no AWS in tests");
    },
  } as unknown as OpCtx<Config>["access"],
  env: "staging",
  clock: { now: () => NOW },
  owned: async () => null,
};

// the shape itself is proved by `pnpm --filter @tc/aws typecheck` (Vitest erases types); this test proves what the runner relies on:
// every method answers with a value that `checkStepResult` accepts, and `describe` answers with a state
it("an adapter of the shape of 10.3 compiles, every method answers with a step result the runner accepts, and the registry can hold adapters of every config type", async () => {
  const lifecycle = [
    adapter.aws.create,
    adapter.aws.suspend,
    adapter.aws.resume,
    adapter.aws.finalSnapshot,
    adapter.aws.destroy,
    adapter.aws.purgeSnapshots,
  ];
  for (const method of lifecycle) expect(checkStepResult(await method(ctx), NOW)).not.toBeNull();
  for (const kind of OPERATION_KINDS) {
    expect(checkStepResult(await adapter.aws.action(kind, ctx), NOW), kind).not.toBeNull();
  }
  expect(await adapter.aws.describe(ctx)).toEqual({ state: "nano" });
  expect(adapter.parseConfig({ plan: "nano" })).toEqual({ plan: "nano" });
  const generic: ProductAdapter<unknown> = adapter;
  expect(generic.family).toBe("linux_instance");
});
