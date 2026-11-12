import type { AccessPort, BucketKeyView } from "../access-invoke.ts";

// Development and test only. An access-details that answers fixed fake secrets, so the reveal screens
// can be seen without AWS. Reached only through the literal dynamic import in runtime.ts, which runs
// when the configuration says fakes (config.ts refuses that in staging and production), so the
// production bundle holds none of this (scripts/smoke-apps.mjs checks it). It is NOT a tenant check:
// the web cores check the ownership before they ask. The values are obviously fake and short-lived
// in memory of the dev server; they are not secrets.

const TWO_KEYS = 2;

export function devAccess(now: () => Date = () => new Date()): AccessPort {
  // bucket id -> keys; the pairs customer:request id that already made a key (R7).
  const keys = new Map<string, BucketKeyView[]>();
  const claimed = new Set<string>();
  let counter = 0;
  return {
    async windowsPassword() {
      return {
        ok: true,
        value: { username: "Administrator", password: "dev-fake-windows-password" },
      };
    },
    async databasePassword() {
      return { ok: true, value: { username: "tcadmin", password: "dev-fake-database-password" } };
    },
    async bucketKeyCreate({ customerId, resourceId, requestId }) {
      const claim = `${customerId}:${requestId}`;
      if (claimed.has(claim)) return { ok: false, error: "already_created" };
      const existing = keys.get(resourceId) ?? [];
      if (existing.length >= TWO_KEYS) return { ok: false, error: "limit_reached" };
      claimed.add(claim);
      counter += 1;
      const accessKeyId = `AKIADEVFAKEKEY${String(counter).padStart(6, "0")}`;
      keys.set(resourceId, [
        ...existing,
        { accessKeyId, status: "active", createdAt: now().toISOString() },
      ]);
      return { ok: true, value: { accessKeyId, secretAccessKey: "dev-fake-secret-access-key" } };
    },
    async bucketKeyList({ resourceId }) {
      return { ok: true, value: { keys: (keys.get(resourceId) ?? []).map((k) => ({ ...k })) } };
    },
  };
}
