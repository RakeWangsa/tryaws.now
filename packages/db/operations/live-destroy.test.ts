import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../client";

vi.mock("./approval", () => ({ readApprovalUntil: async () => null }));

import { insertOperation, liveDestroyOf } from "./insert";

const RESOURCE = "0198f4a0-0000-7000-8000-000000000001";
const LIVE = {
  operationId: "0198f4a0-0000-7000-8000-0000000000aa",
  state: "needs_approval",
  enqueueSeq: 7,
  needsApproval: true,
};

// A scripted transaction: it records the text of every statement and answers the live-destroy lookup
// with `live`; an insert answers one fresh row.
function fakeTx(live: unknown[]) {
  const texts: string[] = [];
  const text = (q: unknown): string =>
    ((q as { queryChunks?: unknown[] }).queryChunks ?? [])
      .map((c) =>
        Array.isArray((c as { value?: unknown }).value)
          ? (c as { value: string[] }).value.join("")
          : "",
      )
      .join("?");
  const tx = {
    execute: async (q: unknown) => {
      const t = text(q);
      texts.push(t);
      if (t.includes("not in ('failed', 'succeeded')")) return { rows: live };
      if (t.includes("insert into operations")) {
        return { rows: [{ operationId: "new", state: "needs_approval", enqueueSeq: 9 }] };
      }
      return { rows: [] };
    },
  } as unknown as Tx;
  return { tx, texts };
}

const destroy = (key: string) => ({
  resourceId: RESOURCE,
  kind: "destroy" as const,
  payload: {},
  idempotencyKey: key,
});

describe("WPU-X23 one live destroy per resource (R7)", () => {
  it("liveDestroyOf answers the oldest live destroy, or null", async () => {
    expect(await liveDestroyOf(fakeTx([LIVE]).tx, RESOURCE)).toEqual(LIVE);
    expect(await liveDestroyOf(fakeTx([]).tx, RESOURCE)).toBeNull();
    expect(await liveDestroyOf(fakeTx([LIVE]).tx, "not-a-uuid")).toBeNull();
  });

  it("a lifecycle destroy under another key replays the live one: no insert", async () => {
    const { tx, texts } = fakeTx([LIVE]);
    const out = await insertOperation(tx, destroy("lifecycle:destroy:sub:2026"), new Date());
    expect(out).toEqual({
      operationId: LIVE.operationId,
      created: false,
      state: "needs_approval",
      enqueueSeq: 7,
    });
    expect(texts.some((t) => t.includes("insert into operations"))).toBe(false);
  });

  it("with no live destroy the row is inserted; other kinds never look", async () => {
    const made = await insertOperation(
      fakeTx([]).tx,
      destroy("lifecycle:destroy:sub:2026"),
      new Date(),
    );
    expect(made.created).toBe(true);
    const reboot = fakeTx([LIVE]);
    const r = await insertOperation(
      reboot.tx,
      { resourceId: RESOURCE, kind: "reboot", payload: {}, idempotencyKey: "x:reboot:1" },
      new Date(),
    );
    expect(r.created).toBe(true);
    expect(reboot.texts.some((t) => t.includes("not in ('failed', 'succeeded')"))).toBe(false);
  });
});
