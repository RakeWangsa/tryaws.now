import type { AdminActor, AdminRepos, AuditRow } from "@tc/db";
import { describe, expect, it } from "vitest";
import { auditFilterOf, auditQueryOf } from "./audit-query.ts";
import { csvCell, makeAuditExport, rowsToCsv, type AuditExportDeps } from "./audit-export.ts";

const actor: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000a1",
  role: "superadmin",
  ip: "203.0.113.5",
};

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: "0191a000-0000-7000-8000-0000000000b1",
  createdAt: new Date("2026-11-12T00:00:00Z"),
  actorType: "admin",
  actorId: actor.adminId,
  action: "payment.refund",
  targetType: "payment",
  targetId: "p1",
  ip: "198.51.100.7",
  userAgent: "agent",
  reason: "because",
  before: null,
  after: { status: "x" },
  extra: {},
  ...over,
});

function harness(
  over: {
    authorize?: () => Promise<AdminActor>;
    limiter?: () => Promise<boolean>;
    exported?: unknown;
  } = {},
) {
  const log: string[] = [];
  const filters: unknown[] = [];
  const deps: AuditExportDeps = {
    authorize: async () => {
      log.push("authorize");
      return (over.authorize ?? (async () => actor))();
    },
    limiter: async () => {
      log.push("limit");
      return (over.limiter ?? (async () => true))();
    },
    run: async (_who, fn) => {
      log.push("run");
      return fn({
        audit: {
          export: async (filter: unknown) => (
            filters.push(filter),
            over.exported ?? {
              ok: true,
              replayed: false,
              value: { rows: [row()], truncated: false },
            }
          ),
        },
      } as unknown as AdminRepos);
    },
    clock: { now: () => new Date("2026-11-12T01:00:00Z") },
  };
  return { deps, log, filters };
}

describe("the CSV", () => {
  it("quotes every cell and defuses spreadsheet formulas", () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvCell(bad), bad).toBe(`"'${bad}"`);
    }
    expect(csvCell("plain,text\nnewline")).toBe('"plain,text\nnewline"');
    expect(csvCell(null)).toBe('""');
  });

  it("has a header, one line per row, and JSON for before and after", () => {
    const csv = rowsToCsv([row({ after: { a: 1 }, reason: "=cmd()" })]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '"id","time","actorType","actorId","action","targetType","targetId","ip","userAgent","reason","before","after","extra"',
    );
    expect(lines[1]).toContain(`"'=cmd()"`);
    expect(lines[1]).toContain('"{""a"":1}"');
  });
});

describe("makeAuditExport", () => {
  it("authorizes, validates, rate limits and runs, in that order (R9), and sends the file with no-store headers", async () => {
    const h = harness();
    const out = await makeAuditExport(h.deps)({ actor: actor.adminId });
    expect(h.log).toEqual(["authorize", "limit", "run"]);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(out.headers["Content-Disposition"]).toMatch(
      /^attachment; filename="audit-2026-11-12\.csv"$/,
    );
    expect(out.headers["Cache-Control"]).toContain("no-store");
    expect(out.headers["X-Export-Truncated"]).toBe("false");
    expect(out.body.split("\r\n")).toHaveLength(3);
    expect(h.filters).toEqual([{ actorId: actor.adminId }]);
  });

  it("says when the cap cut the view", async () => {
    const h = harness({
      exported: { ok: true, replayed: false, value: { rows: [row()], truncated: true } },
    });
    const out = await makeAuditExport(h.deps)({});
    expect(out.status === 200 && out.headers["X-Export-Truncated"]).toBe("true");
  });

  it("answers 403 without a superadmin session and touches nothing", async () => {
    const h = harness({ authorize: async () => Promise.reject(new Error("no")) });
    expect((await makeAuditExport(h.deps)({})).status).toBe(403);
    expect(h.log).toEqual(["authorize"]);
  });

  it("answers 429 over the limit, 503 when the limiter or the database fails, 403 when the repository refuses", async () => {
    expect((await makeAuditExport(harness({ limiter: async () => false }).deps)({})).status).toBe(
      429,
    );
    expect(
      (
        await makeAuditExport(
          harness({ limiter: async () => Promise.reject(new Error("db")) }).deps,
        )({})
      ).status,
    ).toBe(503);
    expect(
      (await makeAuditExport(harness({ exported: { ok: false, error: "forbidden" } }).deps)({}))
        .status,
    ).toBe(403);
    expect(
      (await makeAuditExport(harness({ exported: { ok: false, error: "conflict" } }).deps)({}))
        .status,
    ).toBe(503);
  });

  it("every refusal has no body text and the same no-store headers", async () => {
    const out = await makeAuditExport(harness({ limiter: async () => false }).deps)({});
    expect(out).toMatchObject({
      status: 429,
      headers: { "Cache-Control": expect.stringContaining("no-store") },
    });
    expect("body" in out).toBe(false);
  });
});

describe("the query", () => {
  it("keeps only values of the right shape", () => {
    const q = auditQueryOf({
      actor: "not-a-uuid",
      actorType: "robot",
      targetType: "Bad Type",
      action: "payment.",
      from: "2026-02-30",
      to: "2026-11-12",
      after: ["x"],
    });
    expect(q).toEqual({
      actorId: null,
      actorType: null,
      targetType: null,
      targetId: null,
      action: "payment.",
      from: null,
      to: "2026-11-12",
      after: null,
    });
  });

  it("turns Dhaka days into an inclusive range and drops a reversed one", () => {
    const f = auditFilterOf(auditQueryOf({ from: "2026-11-01", to: "2026-11-02" }));
    expect(f.from?.toISOString()).toBe("2026-10-31T18:00:00.000Z");
    expect(f.to?.toISOString()).toBe("2026-11-02T18:00:00.000Z");
    expect(auditFilterOf(auditQueryOf({ from: "2026-11-05", to: "2026-11-01" }))).toEqual({});
  });
});
