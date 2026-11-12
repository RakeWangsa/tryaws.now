import { describe, expect, it, vi } from "vitest";
import { ABUSE_ACTION_KINDS, abuseActionSchema, makeAbuseAction } from "./abuse-flow.ts";

const U = "11111111-1111-4111-8111-111111111111";

function fakes(order: string[] = []) {
  const authorize = vi.fn(async () => {
    order.push("authorize");
    return { adminId: U, role: "ops" } as never;
  });
  const limiter = vi.fn(async () => {
    order.push("limiter");
    return true;
  });
  const run = vi.fn(async () => {
    order.push("run");
    return { written: { ok: true, replayed: false, value: { message: null } }, message: null };
  });
  const deps = {
    authorize,
    limiter,
    run,
    clock: { now: () => new Date("2026-11-13T00:00:00Z") },
    queue: { send: vi.fn() },
  } as never;
  return { deps, limiter, run };
}

describe("abuse action input (R9 zod)", () => {
  it("the schema accepts exactly the listed kinds", () => {
    for (const kind of ABUSE_ACTION_KINDS) {
      expect(abuseActionSchema.shape.kind.safeParse(kind).success).toBe(true);
    }
    for (const bad of ["", "OpenAbuseCase", "deleteAll", 1, null, undefined, {}, ["addNote"]]) {
      expect(abuseActionSchema.shape.kind.safeParse(bad).success).toBe(false);
    }
  });

  it("authorizes before validating and validates before the limiter", async () => {
    const order: string[] = [];
    const { deps } = fakes(order);
    const r = await makeAbuseAction(deps)({ kind: "bogus" as never, id: U, reason: "why" });
    expect(r).toEqual({ ok: false, code: "invalid" });
    expect(order).toEqual(["authorize"]);
  });

  it("refuses bad input with no limiter hit and no write", async () => {
    const { deps, limiter, run } = fakes();
    const act = makeAbuseAction(deps);
    const cases = [
      { kind: "addNote", id: "x", reason: "why", noteId: U, note: "n" },
      { kind: "closeAbuseCase", id: U, reason: "x".repeat(501) },
      { kind: "closeAbuseCase", id: U, reason: "   " },
      { kind: "openAbuseCase", id: U, reason: "why", resourceId: U, source: "nope" },
      { kind: "openAbuseCase", id: U, reason: "why", resourceId: "x", source: "internal" },
      { kind: "addNote", id: U, reason: "why", noteId: U, note: "" },
      { kind: "addNote", id: U, reason: "why", noteId: U, note: "n".repeat(1001) },
    ];
    for (const c of cases) {
      expect(await act(c as never)).toEqual({ ok: false, code: "invalid" });
    }
    expect(limiter).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("a valid close passes authorize, limiter, run in order", async () => {
    const order: string[] = [];
    const { deps } = fakes(order);
    const r = await makeAbuseAction(deps)({ kind: "closeAbuseCase", id: U, reason: "done" });
    expect(r.ok).toBe(true);
    expect(order).toEqual(["authorize", "limiter", "run"]);
  });

  it("a valid open passes with an optional note", async () => {
    const { deps, run } = fakes();
    const r = await makeAbuseAction(deps)({
      kind: "openAbuseCase",
      id: U,
      reason: "report",
      resourceId: U,
      source: "monitoring",
      notes: "",
    });
    expect(r.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
