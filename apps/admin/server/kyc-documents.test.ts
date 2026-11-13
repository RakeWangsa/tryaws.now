import type { AdminActor, AdminRepos } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  fakeKycDocumentStore,
  KYC_URL_TTL_SECONDS,
  makeKycDocumentHandler,
  unavailableKycStore,
} from "./kyc-documents.ts";

const SUB = "0191a000-0000-7000-8000-000000000002";
const WHY = "id check for case 12";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "support",
  ip: "203.0.113.5",
};

function rig(
  over: { allow?: boolean; limit?: boolean; read?: unknown; store?: "fake" | "none" } = {},
) {
  const steps: string[] = [];
  const store = fakeKycDocumentStore();
  const repos = {
    customers: {
      documentRead: async (input: unknown, reason: unknown) => {
        steps.push(`read:${JSON.stringify(input)}:${String(reason)}`);
        return (
          over.read ?? {
            ok: true,
            replayed: false,
            value: { customerId: "c", key: "kyc/a/front.jpg" },
          }
        );
      },
    },
  } as unknown as AdminRepos;
  const handle = makeKycDocumentHandler({
    authorize: async () => {
      steps.push("authorize");
      if (over.allow === false) throw new Error("no");
      return ACTOR;
    },
    limiter: async () => {
      steps.push("limit");
      return over.limit !== false;
    },
    run: async (_a, fn) => fn(repos),
    store: over.store === "none" ? unavailableKycStore : store,
    clock: { now: () => new Date("2026-11-12T08:00:00.000Z") },
  });
  return { handle, steps, store };
}

describe("the KYC document viewer", () => {
  it("redirects to a short-lived URL, never cached, after the audited read", async () => {
    const r = rig();
    const out = await r.handle({ submissionId: SUB, index: "1", reason: WHY });
    expect(out.status).toBe(302);
    expect(out).toMatchObject({
      location: expect.stringContaining(`expires=${KYC_URL_TTL_SECONDS}`),
    });
    expect(KYC_URL_TTL_SECONDS).toBeLessThanOrEqual(60);
    expect(out.headers["Cache-Control"]).toMatch(/no-store/);
    expect(out.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(r.steps).toEqual([
      "authorize",
      "limit",
      `read:${JSON.stringify({ submissionId: SUB, index: 1 })}:${WHY}`,
    ]);
    expect(r.store.calls).toEqual([{ key: "kyc/a/front.jpg", ttlSeconds: KYC_URL_TTL_SECONDS }]);
  });

  it("every refusal carries the no-store headers and no location", async () => {
    const cases: [ReturnType<typeof rig>, unknown, number][] = [
      [rig({ allow: false }), { submissionId: SUB, index: "0", reason: WHY }, 403],
      [rig(), { submissionId: "x", index: "0", reason: WHY }, 400],
      [rig(), { submissionId: SUB, index: "-1", reason: WHY }, 400],
      [rig(), { submissionId: SUB, index: "abc", reason: WHY }, 400],
      [rig({ limit: false }), { submissionId: SUB, index: "0", reason: WHY }, 429],
      [
        rig({ read: { ok: false, error: "not_found" } }),
        { submissionId: SUB, index: "0", reason: WHY },
        404,
      ],
      [
        rig({ read: { ok: false, error: "forbidden" } }),
        { submissionId: SUB, index: "0", reason: WHY },
        403,
      ],
      [rig({ store: "none" }), { submissionId: SUB, index: "0", reason: WHY }, 503],
    ];
    for (const [r, request, status] of cases) {
      const out = await r.handle(
        request as { submissionId: unknown; index: unknown; reason: unknown },
      );
      expect(out.status).toBe(status);
      expect(out).not.toHaveProperty("location");
      expect(out.headers["Cache-Control"]).toMatch(/no-store/);
    }
  });

  it("refuses a missing, blank or over-long reason with 400 before the limiter and the database (R10)", async () => {
    for (const reason of [undefined, "", "   ", "x".repeat(501), ["a", "b"]]) {
      const r = rig();
      const out = await r.handle({ submissionId: SUB, index: "0", reason });
      expect(out.status).toBe(400);
      expect(out).not.toHaveProperty("location");
      expect(out.headers["Cache-Control"]).toMatch(/no-store/);
      expect(r.steps).toEqual(["authorize"]);
      expect(r.store.calls).toEqual([]);
    }
  });

  it("passes the trimmed reason of the admin to the audited read, not a constant", async () => {
    const r = rig();
    await r.handle({ submissionId: SUB, index: "0", reason: "  second look at the back side  " });
    expect(r.steps[2]).toBe(
      `read:${JSON.stringify({ submissionId: SUB, index: 0 })}:second look at the back side`,
    );
  });

  it("a role without access never reaches the database or the store", async () => {
    const r = rig({ allow: false });
    await r.handle({ submissionId: SUB, index: "0", reason: WHY });
    expect(r.steps).toEqual(["authorize"]);
    expect(r.store.calls).toEqual([]);
  });

  it("when the presign fails after the audited read the answer is 503 with no URL", async () => {
    const r = rig({ store: "none" });
    expect((await r.handle({ submissionId: SUB, index: "0", reason: WHY })).status).toBe(503);
  });
});
