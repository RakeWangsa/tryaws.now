import { OPERATION_STATES } from "@tc/db";
import { expect, it } from "vitest";
import {
  BLOCKED_RETRY_SECONDS,
  decideClaim,
  type ClaimOptions,
  type ClaimView,
} from "./claim-rules";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const LATE = new Date("2026-12-02T00:00:00.000Z");
const UNTIL = new Date("2026-12-01T18:00:00.000Z");
const placed = {
  family: "linux_instance",
  state: "active",
  customerId: "c-1",
  poolAccountId: "pool-1",
  region: "ap-southeast-1",
};
const view = (over: Partial<ClaimView> = {}): ClaimView => ({
  state: "queued",
  kind: "reboot",
  needsApproval: false,
  approvedBy: null,
  resource: placed,
  pool: { awsAccountId: "123456789012", externalId: "ext-1" },
  owner: { orderCustomerId: null, keyCustomerId: null },
  blockedBy: null,
  ...over,
});
const options = (over: Partial<ClaimOptions> = {}): ClaimOptions => ({
  now: NOW,
  approvalUntil: UNTIL,
  hasAdapter: (family) => family === "linux_instance",
  guardInstalled: true,
  ...over,
});
const refused = (code: string) => ({ action: "refuse", code });

it("a queued, placed, unblocked operation of a known kind runs", () => {
  expect(decideClaim(view(), options())).toEqual({ action: "run" });
});

it("[Review Focus 1] every state but queued is skipped, whatever else is wrong", () => {
  for (const state of OPERATION_STATES.filter((s) => s !== "queued")) {
    expect(decideClaim(view({ state, kind: "teleport" }), options()), state).toEqual({
      action: "skip",
    });
  }
});

it("an unknown kind is refused", () => {
  expect(decideClaim(view({ kind: "teleport" }), options())).toEqual(refused("unknown_kind"));
});

it("[Review Focus 2] a destructive kind without the flag is refused before the cutoff and runs after it", () => {
  expect(decideClaim(view({ kind: "destroy" }), options())).toEqual(
    refused("approval_flag_missing"),
  );
  expect(decideClaim(view({ kind: "destroy" }), options({ now: LATE }))).toEqual({ action: "run" });
  expect(decideClaim(view({ kind: "destroy" }), options({ now: new Date(Number.NaN) }))).toEqual(
    refused("approval_flag_missing"),
  );
});

it("the end date moves with the setting, and a missing setting fails closed", () => {
  expect(
    decideClaim(
      view({ kind: "destroy" }),
      options({ now: LATE, approvalUntil: new Date("2027-01-31T00:00:00Z") }),
    ),
  ).toEqual(refused("approval_flag_missing"));
  expect(
    decideClaim(
      view({ kind: "destroy" }),
      options({ approvalUntil: new Date("2026-11-01T00:00:00Z") }),
    ),
  ).toEqual({ action: "run" });
  expect(
    decideClaim(view({ kind: "destroy" }), options({ now: LATE, approvalUntil: null })),
  ).toEqual(refused("approval_flag_missing"));
});

it("a flagged operation needs its approver", () => {
  expect(decideClaim(view({ kind: "destroy", needsApproval: true }), options())).toEqual(
    refused("approval_missing"),
  );
  expect(
    decideClaim(view({ kind: "destroy", needsApproval: true, approvedBy: "admin-1" }), options()),
  ).toEqual({ action: "run" });
});

it("a destructive kind never runs without an installed guard, before or after the cutoff", () => {
  const flagged = view({ kind: "destroy", needsApproval: true, approvedBy: "admin-1" });
  expect(decideClaim(flagged, options({ guardInstalled: false }))).toEqual(
    refused("destructive_guard_missing"),
  );
  expect(
    decideClaim(
      view({ kind: "purge_snapshots", resource: { ...placed, state: "destroyed" } }),
      options({ now: LATE, guardInstalled: false }),
    ),
  ).toEqual(refused("destructive_guard_missing"));
  expect(decideClaim(view(), options({ guardInstalled: false }))).toEqual({ action: "run" });
});

it("a resource that is missing or not placed is refused", () => {
  expect(decideClaim(view({ resource: null }), options())).toEqual(refused("resource_missing"));
  expect(decideClaim(view({ resource: { ...placed, poolAccountId: null } }), options())).toEqual(
    refused("resource_unplaced"),
  );
  expect(decideClaim(view({ resource: { ...placed, region: null } }), options())).toEqual(
    refused("resource_unplaced"),
  );
  expect(decideClaim(view({ pool: null }), options())).toEqual(refused("resource_unplaced"));
});

it("a family without an adapter is refused", () => {
  expect(
    decideClaim(view({ resource: { ...placed, family: "load_balancer" } }), options()),
  ).toEqual(refused("no_adapter"));
});

it("[Review Focus 6] a resource of another customer is refused: by the key of a customer request, and for a create by its order", () => {
  expect(
    decideClaim(view({ owner: { orderCustomerId: null, keyCustomerId: "c-1" } }), options()),
  ).toEqual({ action: "run" });
  expect(
    decideClaim(view({ owner: { orderCustomerId: null, keyCustomerId: "c-2" } }), options()),
  ).toEqual(refused("owner_mismatch"));
  const create = { kind: "create", resource: { ...placed, state: "creating" } } as const;
  expect(
    decideClaim(
      view({ ...create, owner: { orderCustomerId: "c-1", keyCustomerId: null } }),
      options(),
    ),
  ).toEqual({ action: "run" });
  expect(
    decideClaim(
      view({ ...create, owner: { orderCustomerId: "c-2", keyCustomerId: null } }),
      options(),
    ),
  ).toEqual(refused("owner_mismatch"));
  expect(
    decideClaim(
      view({ ...create, owner: { orderCustomerId: null, keyCustomerId: null } }),
      options(),
    ),
  ).toEqual(refused("owner_mismatch"));
});

it("[Review Focus 8] a create runs only on a creating resource, and nothing but purge_snapshots runs on a destroyed one", () => {
  const owner = { orderCustomerId: "c-1", keyCustomerId: null };
  for (const state of ["active", "destroyed", "failed"]) {
    expect(
      decideClaim(view({ kind: "create", owner, resource: { ...placed, state } }), options()),
      state,
    ).toEqual(refused("resource_state"));
  }
  expect(
    decideClaim(
      view({ kind: "create", owner, resource: { ...placed, state: "creating" } }),
      options(),
    ),
  ).toEqual({ action: "run" });
  expect(decideClaim(view({ resource: { ...placed, state: "destroyed" } }), options())).toEqual(
    refused("resource_state"),
  );
  const purge = view({
    kind: "purge_snapshots",
    needsApproval: true,
    approvedBy: "admin-1",
    resource: { ...placed, state: "destroyed" },
  });
  expect(decideClaim(purge, options())).toEqual({ action: "run" });
});

it("reject_operation needs no adapter and no placement and is never blocked, but it still needs an existing resource and the owner check", () => {
  const unplaced = { ...placed, family: "load_balancer", poolAccountId: null, region: null };
  expect(
    decideClaim(view({ kind: "reject_operation", resource: unplaced, pool: null }), options()),
  ).toEqual({ action: "run" });
  expect(decideClaim(view({ kind: "reject_operation", resource: null }), options())).toEqual(
    refused("resource_missing"),
  );
  expect(
    decideClaim(
      view({ kind: "reject_operation", owner: { orderCustomerId: null, keyCustomerId: "c-2" } }),
      options(),
    ),
  ).toEqual(refused("owner_mismatch"));
  // the target of the rejection was retried by an admin: it is queued and older, and it must not hold the rejection back
  expect(
    decideClaim(view({ kind: "reject_operation", blockedBy: "op-target" }), options()),
  ).toEqual({ action: "run" });
});

it("an active operation of the same resource blocks every kind but the engine kind for 60 seconds, but a refusal comes first", () => {
  expect(BLOCKED_RETRY_SECONDS).toBe(60);
  expect(decideClaim(view({ blockedBy: "op-1" }), options())).toEqual({
    action: "block",
    until: new Date("2026-11-11T00:01:00.000Z"),
  });
  expect(decideClaim(view({ blockedBy: "op-1", kind: "destroy" }), options())).toEqual(
    refused("approval_flag_missing"),
  );
});
