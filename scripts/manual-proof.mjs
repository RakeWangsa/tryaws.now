// node scripts/manual-proof.mjs <proof-id>
// A check of gates M1 to M7 for an item that only a person or AWS can prove (verify/manual-proofs.mjs).
//   exit 0  verify/manual-proofs.json holds a valid record {evidence, recordedBy, recordedAt} for the id
//   exit 2  BLOCKED: no record, an invalid record, an unknown id or an unreadable file. Never a pass (R16).
// It reads two files of this repository and nothing else: no network, no AWS, no secret.
// `--records <file>` reads another records file; the gate commands never use it (a test pins that).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MANUAL_PROOFS } from "../verify/manual-proofs.mjs";
import { EXIT, evaluateProof, parseRecords } from "./lib/manual-proof.mjs";

const args = process.argv.slice(2);
let file = resolve(import.meta.dirname, "../verify/manual-proofs.json");
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--records" && args[i + 1] !== undefined) {
    file = resolve(args[i + 1]);
    i++;
  } else {
    positional.push(args[i]);
  }
}

const finish = (exit, lines) => {
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.exit(exit);
};

if (positional.length !== 1) {
  finish(EXIT.blocked, ["BLOCKED: usage: node scripts/manual-proof.mjs <proof-id>"]);
}
const [id] = positional;

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  finish(EXIT.blocked, [`BLOCKED: manual proof ${id}: the records file cannot be read`]);
}
const parsed = parseRecords(text);
if (!parsed.ok) finish(EXIT.blocked, [`BLOCKED: manual proof ${id}: ${parsed.reason}`]);

const verdict = evaluateProof(id, MANUAL_PROOFS, parsed.records);
finish(verdict.exit, verdict.lines);
