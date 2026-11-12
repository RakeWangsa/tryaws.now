// The logic of scripts/manual-proof.mjs (gates M1 to M7). Some items can only be proven by a person
// or on AWS. Such an item is a check that fails (BLOCKED, exit 2) until verify/manual-proofs.json holds
// a valid record for its id. A missing, unreadable or malformed file blocks too (R16, fail closed).
// Nothing here reads the network, a secret or the clock unless `now` is not passed.

export const EXIT = { passed: 0, failed: 1, blocked: 2 };

export const MIN_EVIDENCE_LENGTH = 20;
export const MIN_NAME_LENGTH = 2;

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ISO 8601 with a date, a time and a zone, e.g. 2026-11-13T21:05:00Z or 2026-11-13T21:05:00+06:00.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Is this a valid record {evidence, recordedBy, recordedAt}? Returns { ok: true } or { ok: false, reason }.
 * evidence: a sentence that says what was seen and where it is written down (at least 20 characters).
 * recordedBy: the person. recordedAt: an ISO 8601 date-time with a zone, not later than `now`.
 * Other keys are refused, so that a typo in a key name cannot look like a record.
 */
export function validateRecord(record, now = new Date()) {
  if (!isPlainObject(record)) return { ok: false, reason: "the record is not an object" };
  const allowed = new Set(["evidence", "recordedBy", "recordedAt"]);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) return { ok: false, reason: `unknown key: ${extra.sort().join(", ")}` };
  const { evidence, recordedBy, recordedAt } = record;
  if (typeof evidence !== "string" || evidence.trim().length < MIN_EVIDENCE_LENGTH) {
    return {
      ok: false,
      reason: `evidence must be a text of at least ${MIN_EVIDENCE_LENGTH} characters`,
    };
  }
  if (typeof recordedBy !== "string" || recordedBy.trim().length < MIN_NAME_LENGTH) {
    return { ok: false, reason: "recordedBy must name the person" };
  }
  if (typeof recordedAt !== "string" || !ISO_DATE_TIME.test(recordedAt)) {
    return { ok: false, reason: "recordedAt must be an ISO 8601 date-time with a zone" };
  }
  const time = Date.parse(recordedAt);
  if (Number.isNaN(time)) return { ok: false, reason: "recordedAt is not a real date" };
  if (time > now.getTime()) return { ok: false, reason: "recordedAt is in the future" };
  return { ok: true };
}

/** Parse the text of manual-proofs.json: { ok: true, records } for a JSON object, else { ok: false, reason }. */
export function parseRecords(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "verify/manual-proofs.json is not valid JSON" };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: "verify/manual-proofs.json is not a JSON object" };
  }
  return { ok: true, records: value };
}

/**
 * The verdict for one proof id. `catalogue` maps ids to { description, ... }; `records` maps ids to records.
 * Returns { exit, lines }: exit 0 only for a known id with a valid record; otherwise 2 (BLOCKED).
 */
export function evaluateProof(id, catalogue, records, now = new Date()) {
  const blocked = (reason) => ({
    exit: EXIT.blocked,
    lines: [`BLOCKED: manual proof ${id}: ${reason}`],
  });
  if (typeof id !== "string" || id === "" || !Object.hasOwn(catalogue, id)) {
    return blocked("not in the catalogue verify/manual-proofs.mjs");
  }
  const need = `a person records {evidence, recordedBy, recordedAt} for it in verify/manual-proofs.json. Needed: ${catalogue[id].description}`;
  if (!Object.hasOwn(records, id)) return blocked(`no record. ${need}`);
  const verdict = validateRecord(records[id], now);
  if (!verdict.ok) return blocked(`the record is not valid (${verdict.reason}). ${need}`);
  return {
    exit: EXIT.passed,
    lines: [
      `manual proof ${id}: recorded by ${records[id].recordedBy.trim()} at ${records[id].recordedAt}`,
    ],
  };
}

/** The ids of `records` that the catalogue does not know (a typo would otherwise hide a missing proof). */
export function unknownRecordIds(catalogue, records) {
  return Object.keys(records)
    .filter((id) => !Object.hasOwn(catalogue, id))
    .sort();
}
