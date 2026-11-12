import { describe, expect, it } from "vitest";
import {
  EXIT,
  evaluateProof,
  parseRecords,
  unknownRecordIds,
  validateRecord,
} from "./manual-proof.mjs";

const NOW = new Date("2026-11-14T12:00:00Z");
const RECORD = {
  evidence: "Seen on staging by two people, written in JOURNEY.md",
  recordedAt: "2026-11-13T21:05:00+06:00",
  recordedBy: "Moshiur Rahman",
};
const CATALOGUE = { "a-proof": { description: "something a person saw" } };

describe("validateRecord", () => {
  it("accepts a record with evidence, a person and a past ISO date-time", () => {
    expect(validateRecord(RECORD, NOW)).toEqual({ ok: true });
    expect(validateRecord({ ...RECORD, recordedAt: "2026-11-13T15:05:00.250Z" }, NOW)).toEqual({
      ok: true,
    });
  });
  it.each([
    ["null", null],
    ["a string", "done"],
    ["an array", [RECORD]],
    ["no evidence", { ...RECORD, evidence: undefined }],
    ["short evidence", { ...RECORD, evidence: "done" }],
    ["blank evidence", { ...RECORD, evidence: " ".repeat(40) }],
    ["evidence that is not text", { ...RECORD, evidence: 123456789 }],
    ["no person", { ...RECORD, recordedBy: undefined }],
    ["an empty person", { ...RECORD, recordedBy: " " }],
    ["a date without a zone", { ...RECORD, recordedAt: "2026-11-13T21:05:00" }],
    ["a date without a time", { ...RECORD, recordedAt: "2026-11-13" }],
    ["a date that is not text", { ...RECORD, recordedAt: 1794000000000 }],
    ["an impossible date", { ...RECORD, recordedAt: "2026-13-45T25:61:00Z" }],
    ["a date in the future", { ...RECORD, recordedAt: "2026-11-15T00:00:00Z" }],
    ["an unknown key", { ...RECORD, approved: true }],
  ])("refuses %s", (_name, record) => {
    expect(validateRecord(record, NOW).ok).toBe(false);
  });
  it("gives a reason that names the problem and never repeats the evidence", () => {
    const result = validateRecord({ ...RECORD, evidence: "x" }, NOW);
    expect(result.reason).toContain("evidence");
    expect(result.reason).not.toContain("x ");
  });
});

describe("parseRecords", () => {
  it("accepts a JSON object and nothing else", () => {
    expect(parseRecords("{}")).toEqual({ ok: true, records: {} });
    expect(parseRecords('{"a-proof": {}}').ok).toBe(true);
    for (const text of ["", "[]", "null", '"x"', "12", "{ nope"]) {
      expect(parseRecords(text).ok, text).toBe(false);
    }
  });
});

describe("evaluateProof (a proof passes only with a valid record)", () => {
  it("is BLOCKED (exit 2) with an empty json and says what a person must record", () => {
    const result = evaluateProof("a-proof", CATALOGUE, {}, NOW);
    expect(result.exit).toBe(EXIT.blocked);
    expect(result.exit).toBe(2);
    expect(result.lines.join("\n")).toContain("BLOCKED");
    expect(result.lines.join("\n")).toContain("something a person saw");
  });
  it("is BLOCKED for an invalid record and for a record of another id", () => {
    expect(evaluateProof("a-proof", CATALOGUE, { "a-proof": { evidence: "x" } }, NOW).exit).toBe(2);
    expect(evaluateProof("a-proof", CATALOGUE, { "other-id": RECORD }, NOW).exit).toBe(2);
  });
  it("is BLOCKED for an id that is not in the catalogue, even with a valid record", () => {
    for (const id of ["unknown", "", undefined, "__proto__", "toString"]) {
      expect(evaluateProof(id, CATALOGUE, { [id]: RECORD }, NOW).exit, String(id)).toBe(2);
    }
  });
  it("passes with a valid record and names the person", () => {
    const result = evaluateProof("a-proof", CATALOGUE, { "a-proof": RECORD }, NOW);
    expect(result.exit).toBe(EXIT.passed);
    expect(result.lines.join("\n")).toContain("Moshiur Rahman");
    expect(result.lines.join("\n")).not.toContain("BLOCKED");
  });
  it("does not print the evidence text", () => {
    const result = evaluateProof("a-proof", CATALOGUE, { "a-proof": RECORD }, NOW);
    expect(result.lines.join("\n")).not.toContain(RECORD.evidence);
  });
});

describe("unknownRecordIds", () => {
  it("lists record ids that the catalogue does not know, sorted", () => {
    expect(
      unknownRecordIds(CATALOGUE, { "b-typo": RECORD, "a-proof": RECORD, "a-typo": RECORD }),
    ).toEqual(["a-typo", "b-typo"]);
    expect(unknownRecordIds(CATALOGUE, {})).toEqual([]);
  });
});
