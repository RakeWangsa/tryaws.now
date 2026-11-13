import { ADMIN_TRANSITIONS, canTransition } from "@tc/core";
import { OPERATION_STATES, type OperationStateName } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  ACTION_TRANSITIONS,
  actionsFor,
  ERROR_CODES,
  judge,
  mapLastError,
  OPS_ACTION_KINDS,
} from "./ops-map.ts";

const facts = (
  state: OperationStateName,
  over: { kind?: string; approvedBy?: string | null } = {},
) => ({
  state,
  kind: over.kind ?? "destroy",
  approvedBy: over.approvedBy ?? null,
});

describe("mapLastError (R14)", () => {
  it("maps a known code, with or without the plain error name after it", () => {
    expect(mapLastError("upstream_unavailable")).toBe("upstream_unavailable");
    expect(mapLastError("upstream_unavailable:ThrottlingException")).toBe("upstream_unavailable");
    expect(mapLastError("lease_expired")).toBe("lease_expired");
  });

  it("WPU-X3: maps the outcomes of a 'registry confirmed not renewed' check", () => {
    for (const code of [
      "renewal_unrenewed_confirmed",
      "renewal_not_confirmable",
      "registry_renewed",
      "renewal_in_progress",
      "expiry_changed",
      "renewal_unreadable",
      "registry_unreachable",
      "target_changed",
      "renewal_check_missing",
    ]) {
      expect(mapLastError(code), code).toBe(code);
    }
  });

  it("never passes stored text through", () => {
    const leaked =
      "arn:aws:iam::123456789012:role/TcProvisioner is not authorized AKIAIOSFODNN7EXAMPLE";
    expect(mapLastError(leaked)).toBe("other");
    expect(mapLastError("password=hunter2")).toBe("other");
    expect(mapLastError("")).toBeNull();
    expect(mapLastError(null)).toBeNull();
    expect((ERROR_CODES as readonly string[]).includes("other")).toBe(false);
  });
});

describe("the actions follow ADMIN_TRANSITIONS only", () => {
  it("every state change an action makes is a move an admin has", () => {
    for (const kind of OPS_ACTION_KINDS) {
      for (const [from, to] of ACTION_TRANSITIONS[kind]) {
        expect(canTransition("admin", from, to), `${kind}: ${from} -> ${to}`).toBe(true);
      }
    }
    const used = OPS_ACTION_KINDS.flatMap((k) =>
      ACTION_TRANSITIONS[k].map(([f, t]) => `${f}>${t}`),
    );
    expect(used.sort()).toEqual(ADMIN_TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort());
  });

  it("an admin cannot cancel a queued, running or waiting operation, nor fail a stuck one", () => {
    for (const from of ["queued", "running", "waiting"] as const) {
      expect(canTransition("admin", from, "failed")).toBe(false);
      for (const kind of OPS_ACTION_KINDS) {
        expect(judge(kind, facts(from))).not.toBe("do");
      }
    }
    expect(canTransition("admin", "needs_attention", "failed")).toBe(false);
  });
});

describe("judge", () => {
  it("allows approve and reject of a waiting approval, and retry of a stuck operation", () => {
    expect(judge("approveOperation", facts("needs_approval"))).toBe("do");
    expect(judge("rejectOperation", facts("needs_approval"))).toBe("do");
    expect(judge("retryOperation", facts("needs_attention"))).toBe("do");
    expect(judge("rejectOperation", facts("needs_attention"))).toBe("do");
  });

  it("refuses to reject a paid create (open point 14)", () => {
    expect(judge("rejectOperation", facts("needs_approval", { kind: "create" }))).toBe("refuse");
  });

  it("knows a replay: the state the finished action leaves", () => {
    expect(judge("approveOperation", facts("queued", { approvedBy: "a" }))).toBe("replay");
    expect(judge("retryOperation", facts("queued"))).toBe("replay");
    expect(judge("rejectOperation", facts("failed"))).toBe("replay");
  });

  it("refuses every other pair, including approve of an operation nobody approved", () => {
    expect(judge("approveOperation", facts("queued"))).toBe("refuse");
    expect(judge("approveOperation", facts("needs_attention"))).toBe("refuse");
    expect(judge("retryOperation", facts("needs_approval"))).toBe("refuse");
    expect(judge("retryOperation", facts("failed"))).toBe("refuse");
    for (const state of OPERATION_STATES) {
      if (state !== "needs_approval") {
        expect(judge("approveOperation", facts(state))).not.toBe("do");
      }
    }
  });

  it("shows the buttons the state allows and no others", () => {
    expect(actionsFor(facts("needs_approval"))).toEqual(["approveOperation", "rejectOperation"]);
    expect(actionsFor(facts("needs_attention"))).toEqual(["rejectOperation", "retryOperation"]);
    expect(actionsFor(facts("queued"))).toEqual([]);
    expect(actionsFor(facts("running"))).toEqual([]);
    expect(actionsFor(facts("failed"))).toEqual([]);
  });
});
