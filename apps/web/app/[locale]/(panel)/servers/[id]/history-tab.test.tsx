import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { historyBn } from "../../../../../messages/history-bn.ts";
import { historyEn } from "../../../../../messages/history-en.ts";
import { HISTORY_KINDS, HISTORY_STATES } from "../../../../../server/resource-history.ts";
import { html } from "../mockup-states.tsx";
import { HistoryTab } from "./HistoryTab.tsx";

// WPU-N1: the History tab states in bn and en, and its messages.

const at = new Date("2026-11-01T10:00:00Z");
const ready = {
  state: "ready" as const,
  items: [
    { id: "a", kind: "reboot" as const, state: "succeeded" as const, at },
    { id: "b", kind: "other" as const, state: "needs_attention" as const, at },
  ],
};

describe("HistoryTab", () => {
  it("lists the requests in both languages", () => {
    const en = html(<HistoryTab screen={ready} numerals="latn" />, "en");
    expect(en).toContain("Reboot");
    expect(en).toContain("Done");
    expect(en).toContain("Other change");
    const bn = html(<HistoryTab screen={ready} numerals="beng" />, "bn");
    expect(bn).toContain(historyBn.History.kind.reboot);
    expect(bn).toContain(historyBn.History.state.succeeded);
  });
  it("has an empty and an error state, and the error is not shown as empty (R16)", () => {
    expect(
      html(<HistoryTab screen={{ state: "ready", items: [] }} numerals="latn" />, "en"),
    ).toContain(historyEn.History.empty.title);
    const err = html(<HistoryTab screen={{ state: "error" }} numerals="latn" />, "en");
    expect(err).toContain(historyEn.History.error.title);
    expect(err).not.toContain(historyEn.History.empty.title);
  });
  it("names every kind and state, with the same keys in bn and en and no forbidden wording", () => {
    for (const k of [...HISTORY_KINDS, "other"]) {
      expect(historyBn.History.kind).toHaveProperty(k);
      expect(historyEn.History.kind).toHaveProperty(k);
    }
    for (const s of HISTORY_STATES) {
      expect(historyBn.History.state).toHaveProperty(s);
      expect(historyEn.History.state).toHaveProperty(s);
    }
    expect(messageKeys(historyBn)).toEqual(messageKeys(historyEn));
    expect(forbiddenWording(historyEn)).toEqual([]);
  });
});
