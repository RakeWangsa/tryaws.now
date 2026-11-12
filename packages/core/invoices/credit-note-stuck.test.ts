import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent } from "../operations/types";

// WPU-B3: a credit note that is refused again and again is escalated by the age of its reversal. The
// repositories are replaced; the .db tests prove the SQL and the numbers.

const h = vi.hoisted(() => ({
  creditNotesToIssue: vi.fn(),
  resolveCreditNoteNotice: vi.fn(async () => undefined),
  issueCreditNote: vi.fn(),
}));
vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  invoiceBacklogRepo: () => ({
    creditNotesToIssue: h.creditNotesToIssue,
    resolveCreditNoteNotice: h.resolveCreditNoteNotice,
  }),
  customerRepos: () => ({ invoices: { issueCreditNote: h.issueCreditNote } }),
}));

const { CREDIT_NOTE_STUCK_HOURS, creditNoteIsStuck, issueCreditNotes } =
  await import("./credit-note");

const NOW = new Date("2026-11-13T12:00:00.000Z");
const HOUR = 3_600_000;
const entry = (n: number, hoursOld: number) => ({
  customerId: `0198f0c0-0000-7000-8000-00000000c0${n}`.slice(0, 36),
  reversalTransactionId: `0198f0c0-0000-7000-8000-00000000d0${n}`.slice(0, 36),
  ledgerTransactionId: `0198f0c0-0000-7000-8000-00000000e0${n}`.slice(0, 36),
  reversedAt: new Date(NOW.getTime() - hoursOld * HOUR),
});
const logs: LogEvent[] = [];
const deps = {
  runTx: async <T>(fn: (tx: never) => Promise<T>) => fn({} as never),
  clock: { now: () => NOW },
  log: (e: LogEvent) => void logs.push(e),
};

beforeEach(() => {
  logs.length = 0;
  for (const fn of Object.values(h)) fn.mockReset();
  h.resolveCreditNoteNotice.mockResolvedValue(undefined);
});

describe("creditNoteIsStuck", () => {
  it("is false before the limit, true at the limit and after it", () => {
    expect(CREDIT_NOTE_STUCK_HOURS).toBe(24);
    const at = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
    expect(creditNoteIsStuck(at(0), NOW)).toBe(false);
    expect(creditNoteIsStuck(at(23.99), NOW)).toBe(false);
    expect(creditNoteIsStuck(at(24), NOW)).toBe(true);
    expect(creditNoteIsStuck(at(500), NOW)).toBe(true);
  });
  it("is true for a date it cannot read (R16: a check that cannot finish escalates)", () => {
    expect(creditNoteIsStuck(new Date("nope"), NOW)).toBe(true);
  });
});

describe("issueCreditNotes escalation", () => {
  it("counts and logs one alert for a refused credit note older than the limit, not for a young one", async () => {
    h.creditNotesToIssue.mockResolvedValue([entry(1, 30), entry(2, 2)]);
    h.issueCreditNote.mockResolvedValue({ ok: false, error: "amount_mismatch" });
    const run = await issueCreditNotes(deps, 10);
    expect(run).toEqual({ issued: 0, replayed: 0, refused: 2, stuck: 1 });
    const stuck = logs.filter((l) => l.event === "credit_note_stuck");
    expect(stuck).toEqual([
      {
        event: "credit_note_stuck",
        severity: "alert",
        ledgerTransactionId: entry(1, 30).ledgerTransactionId,
        reason: "amount_mismatch",
        ageHours: 30,
      },
    ]);
  });

  it("escalates a failure (a thrown error) the same way, with the error name only", async () => {
    h.creditNotesToIssue.mockResolvedValue([entry(3, 100)]);
    h.issueCreditNote.mockRejectedValue(new TypeError("secret detail 0123456789"));
    const run = await issueCreditNotes(deps, 10);
    expect(run.stuck).toBe(1);
    const alert = logs.find((l) => l.event === "credit_note_stuck");
    expect(alert).toMatchObject({ reason: "TypeError", ageHours: 100 });
    expect(JSON.stringify(logs)).not.toContain("secret detail");
  });

  it("does not escalate an issued or replayed credit note, however old", async () => {
    h.creditNotesToIssue.mockResolvedValue([entry(4, 200), entry(5, 200)]);
    h.issueCreditNote
      .mockResolvedValueOnce({ ok: true, replayed: false })
      .mockResolvedValueOnce({ ok: true, replayed: true });
    const run = await issueCreditNotes(deps, 10);
    expect(run).toEqual({ issued: 1, replayed: 1, refused: 0, stuck: 0 });
    expect(logs.filter((l) => l.event === "credit_note_stuck")).toEqual([]);
  });

  it("escalates every run: a credit note refused again is alerted again (the alarm needs the line each run)", async () => {
    h.creditNotesToIssue.mockResolvedValue([entry(6, 48)]);
    h.issueCreditNote.mockResolvedValue({ ok: false, error: "amount_mismatch" });
    await issueCreditNotes(deps, 10);
    await issueCreditNotes(deps, 10);
    expect(logs.filter((l) => l.event === "credit_note_stuck")).toHaveLength(2);
  });
});
