import { describe, expect, it } from "vitest";
import { runStep } from "./step";
import { useHarness } from "./test/harness";
import { seedOperation, seedResource } from "./test/seed";

const { t, world, setup, message, resourceRow } = useHarness();

// WPU-B5 item 22 (JOURNEY T7-3): the provisioner sets `config.adminSuspended` when an admin suspension
// finishes and clears it when an admin restore finishes. A lifecycle suspend or resume leaves it alone.
async function run(
  kind: "suspend" | "resume",
  state: string,
  config: Record<string, unknown>,
  payload: Record<string, unknown> | null,
) {
  const resourceId = await seedResource(t.pool, world, { state, config: JSON.stringify(config) });
  const id = await seedOperation(t.pool, resourceId, {
    kind,
    ...(payload === null ? {} : { payload: JSON.stringify(payload) }),
  });
  const { deps } = setup();
  const out = await runStep(deps, message(id, resourceId));
  return { out, row: await resourceRow(resourceId) };
}

describe("config.adminSuspended", () => {
  it("is set when a suspend with adminSuspended in its payload succeeds", async () => {
    const { out, row } = await run("suspend", "active", {}, { adminSuspended: true });
    expect(out).toMatchObject({ outcome: "advanced", to: "succeeded" });
    expect(row.config).toMatchObject({ adminSuspended: true });
  });

  it("is not set by a lifecycle suspend (no marker in the payload)", async () => {
    const { row } = await run("suspend", "active", {}, null);
    expect((row.config as Record<string, unknown>).adminSuspended).toBeUndefined();
  });

  it("is cleared when a resume with adminSuspended false succeeds", async () => {
    const { row } = await run(
      "resume",
      "suspended",
      { adminSuspended: true },
      { adminSuspended: false },
    );
    expect((row.config as Record<string, unknown>).adminSuspended).toBe(false);
  });

  it("is kept by a lifecycle resume (no marker in the payload)", async () => {
    const { row } = await run("resume", "suspended", { adminSuspended: true }, null);
    expect(row.config).toMatchObject({ adminSuspended: true });
  });

  it("ignores a marker that is not a boolean", async () => {
    const { row } = await run("suspend", "active", {}, { adminSuspended: "true" });
    expect((row.config as Record<string, unknown>).adminSuspended).toBeUndefined();
  });
});
