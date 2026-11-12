import { describe, expect, it, vi } from "vitest";
import { html } from "../../_family/render-html.tsx";
import { DATABASE_ID, REQUEST_ID, detail, plan } from "../databases.fixtures.ts";
import { DatabaseBackups } from "./DatabaseBackups.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// WPU-G9: the Backups tab of a database. Prices come from the server; states are words (U11).
const noop = async () => ({});
const SNAP = "0190aaaa-0000-7000-8000-0000000000e2";
const NOW = new Date("2026-11-12T08:00:00Z");
const snapshot = (over = {}) => ({
  id: SNAP,
  name: "before migration",
  sizeGb: 10,
  monthlyMinor: 4500n,
  createdAt: NOW,
  state: "active",
  final: false,
  ...over,
});
const view = (
  over: Partial<ReturnType<typeof detail>> = {},
  locale: "bn" | "en" = "en",
  numerals: "beng" | "latn" = "latn",
) =>
  html(
    <DatabaseBackups
      database={detail({
        state: "active",
        backups: [snapshot()],
        restorePlans: [plan({ priceMinor: 520000n })],
        ...over,
      })}
      numerals={numerals}
      requestIds={{ create: REQUEST_ID, delete: REQUEST_ID }}
      createAction={noop}
      deleteAction={noop}
      restoreAction={noop}
      pitrAction={noop}
    />,
    locale,
  );

describe("database backups tab", () => {
  it("shows the real price, the retention, the snapshot with its monthly price and a delete button", () => {
    const out = view();
    expect(out).toContain("7 days");
    expect(out).toContain("Snapshot price:");
    expect(out).toContain("before migration");
    expect(out).toContain("Delete");
    expect(out).toContain('name="databaseId"');
    expect(out).toContain(`value="${DATABASE_ID}"`);
    expect(out).toContain("10 GB");
    expect(out).not.toMatch(/ style="/);
    expect(out).not.toMatch(/arn:aws|\b\d{12}\b/);
  });

  it("price unavailable: says so, and the create button is switched off (R16)", () => {
    const out = view({ snapshotPrice: { state: "unavailable" } });
    expect(out).toContain("snapshot price is not known right now");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>\s*Take a snapshot/);
  });

  it("a stopped database says why a snapshot cannot be taken", () => {
    const out = view({ state: "stopped" });
    expect(out).toContain("must be running to take a snapshot");
  });

  it("empty state; a final snapshot has no delete button and is named as automatic", () => {
    expect(view({ backups: [] })).toContain("No snapshot yet");
    const out = view({ backups: [snapshot({ final: true, name: "last one" })] });
    expect(out).toContain("Automatic, before a delete");
    expect(out).not.toContain(">Delete<");
  });

  it("the restore form posts the snapshot, plan, name and the Region; the point-in-time form posts the source and a Dhaka time", () => {
    const out = view();
    for (const name of [
      "restoreFromBackupId",
      "productId",
      "displayName",
      "region",
      "restoreSourceId",
      "restoreTime",
    ]) {
      expect(out).toContain(`name="${name}"`);
    }
    expect(out).toContain('type="datetime-local"');
    expect(out).toContain("Dhaka time");
    expect(out).toContain("per month");
  });

  it("without a ready snapshot or a plan the restore says it cannot be used yet", () => {
    const out = view({ backups: [snapshot({ state: "creating" })], restorePlans: [] });
    expect(out).toContain("no ready snapshot or suitable plan");
    expect(out).toContain("no suitable plan right now");
  });

  it("is written in Bengali with Bengali numerals", () => {
    const out = view({}, "bn", "beng");
    expect(out).toMatch(/[ঀ-৿]/);
    expect(out).toContain("স্ন্যাপশট");
  });
});
