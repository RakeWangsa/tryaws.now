import { AwsError, type AwsAccess, type ProductAdapter } from "@tc/aws";
import { awsResourceName, stepDone, stepNext, stepWait } from "@tc/core";

export interface FakeCloud {
  readonly instances: Map<string, { polls: number; ip: string | null }>;
  createCalls: number;
  destroyCalls: number;
  loseAnswers: number;
  strictDelete: boolean;
}

export function createFakeCloud(): FakeCloud {
  return {
    instances: new Map(),
    createCalls: 0,
    destroyCalls: 0,
    loseAnswers: 0,
    strictDelete: false,
  };
}

const lostAnswer = () =>
  new AwsError({
    code: "upstream_unavailable",
    retryable: true,
    awsErrorName: "ServiceException",
    operation: "CreateInstances",
  });

const notFound = () =>
  new AwsError({ code: "not_found", retryable: true, operation: "DeleteInstance" });

// A family with the steps of 10.1: create, wait for running, allocate the ip; destroy.
export function fakeInstanceAdapter(cloud: FakeCloud): ProductAdapter<{ readonly plan: string }> {
  const ensure = (name: string) => {
    let instance = cloud.instances.get(name);
    if (instance === undefined) {
      instance = { polls: 0, ip: null };
      cloud.instances.set(name, instance);
    }
    return instance;
  };

  return {
    family: "linux_instance",
    parseConfig: (input) => {
      const plan = (input as { plan?: unknown } | null)?.plan;
      return { plan: String(plan ?? "nano") };
    },
    aws: {
      async create(ctx) {
        const name = awsResourceName("instance", ctx.resource.id);
        switch (ctx.operation.step) {
          case null: {
            cloud.createCalls += 1;
            // A repeat adopts the instance that is already there (the idempotency of 10.1).
            ensure(name);
            if (cloud.loseAnswers > 0) {
              cloud.loseAnswers -= 1;
              throw lostAnswer();
            }
            return stepNext("wait_running", { awsName: name });
          }
          case "wait_running": {
            const instance = ensure(name);
            instance.polls += 1;
            if (instance.polls < 3) {
              return stepWait("wait_running", new Date(ctx.clock.now().getTime() + 30_000));
            }
            return stepNext("allocate_ip");
          }
          case "allocate_ip": {
            const instance = ensure(name);
            instance.ip = "198.51.100.7";
            return stepDone({ state: "active", configMerge: { ip: "198.51.100.7" } });
          }
          default:
            throw new AwsError({ code: "validation", retryable: false });
        }
      },
      async suspend() {
        return stepDone();
      },
      async resume() {
        return stepDone();
      },
      async finalSnapshot() {
        return stepDone();
      },
      async destroy(ctx) {
        const name = awsResourceName("instance", ctx.resource.id);
        cloud.destroyCalls += 1;
        if (cloud.loseAnswers > 0) {
          cloud.loseAnswers -= 1;
          cloud.instances.delete(name);
          throw lostAnswer();
        }
        try {
          if (!cloud.instances.has(name) && cloud.strictDelete) throw notFound();
          cloud.instances.delete(name);
        } catch (error) {
          // A step that deletes treats "not found" as done.
          if (!(error instanceof AwsError && error.code === "not_found")) throw error;
        }
        return stepDone({ state: "destroyed" });
      },
      async purgeSnapshots() {
        return stepDone();
      },
      async describe() {
        return { state: "active" };
      },
      async action() {
        return stepDone();
      },
    },
  };
}

export function fakeAccess(): AwsAccess<"provisioner"> {
  return {
    caller: "provisioner",
    lightsail: () => {
      throw new Error("no AWS in tests");
    },
    route53: () => {
      throw new Error("no AWS in tests");
    },
  };
}
