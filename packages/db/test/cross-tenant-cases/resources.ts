import { v7 as uuidv7 } from "uuid";
import { ghostOf } from "../../testing/cross-tenant";
import { newResource, uniqueSuffix } from "../fixtures";
import { defineCaseSet, type CaseSet } from "./define";

export const resourcesCases: CaseSet = defineCaseSet<{
  resourceId: string;
  family: string;
  serverId: string;
}>({
  repo: "resources",
  // Each customer gets a family of its own: customer B is seeded too, and a shared family would
  // make B's count of its own resource look like a leak of A's.
  seed: async (pool, customerId) => {
    const family = "fam_" + uniqueSuffix();
    const resourceId = await newResource(pool, customerId, { family });
    // A backup under the resource, for listChildren.
    await newResource(pool, customerId, { family: "backup", parent_resource_id: resourceId });
    // A server, the parent of createBackupRow.
    const serverId = await newResource(pool, customerId);
    return { resourceId, family, serverId };
  },
  cases: ({ asCustomer }) => ({
    "resources.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.resources.list()) },
    "resources.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.resources.get(s.resourceId)),
    },
    // The children of one parent: the ghost parent has none, and the parent of A is not B's.
    "resources.listChildren": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.resources.listChildren(s.resourceId, "backup")),
    },
    // B's attempt to hang a backup under A's resource is not_found, as under a missing one.
    "resources.createBackupRow": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.resources.createBackupRow({
            id: uuidv7(),
            parentId: s.serverId,
            displayName: "manual",
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
    // The answer is a number, which names no id; the ghost names another family, so that the run of
    // customer A on its own resources (1) differs from the run on a family it has none of (0).
    "resources.countLive": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.resources.countLive(s.family)),
      ghost: (s) => ({ ...ghostOf(s), family: "ghost_family" }),
    },
  }),
});
