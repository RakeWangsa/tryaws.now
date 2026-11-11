import { RESOURCE_STATES } from "@tc/db";
import { AWS_NAME_TYPES } from "../naming/index";

export const STEP_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_WAIT_SECONDS = 86_400;
export const MAX_PATCH_BYTES = 16_384;

// What a step may change on its resource: the columns worker_rw may update, except deleted_at.
export interface StepPatch {
  readonly state?: (typeof RESOURCE_STATES)[number];
  readonly awsName?: string;
  readonly configMerge?: Readonly<Record<string, unknown>>;
}

// `step` is the step to run next; for `wait` it runs after `until`.
export type StepResult =
  | { readonly kind: "next"; readonly step: string; readonly patch?: StepPatch }
  | {
      readonly kind: "wait";
      readonly step: string;
      readonly until: Date;
      readonly patch?: StepPatch;
    }
  | { readonly kind: "done"; readonly patch?: StepPatch };

export function stepNext(step: string, patch?: StepPatch): StepResult {
  return Object.freeze(
    patch === undefined ? { kind: "next", step } : { kind: "next", step, patch },
  );
}

export function stepWait(step: string, until: Date, patch?: StepPatch): StepResult {
  return Object.freeze(
    patch === undefined ? { kind: "wait", step, until } : { kind: "wait", step, until, patch },
  );
}

export function stepDone(patch?: StepPatch): StepResult {
  return Object.freeze(patch === undefined ? { kind: "done" } : { kind: "done", patch });
}

const AWS_NAME = new RegExp(`^tc-(?:${AWS_NAME_TYPES.join("|")})-[0-9a-f]{16}$`);
const SECRET_KEY = /pass(word)?|secret|token|private/i;
const PATCH_KEYS = new Set(["state", "awsName", "configMerge"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkConfigMerge(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => SECRET_KEY.test(key))) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_PATCH_BYTES) return null;
  // The copy is what JSON can carry, so nothing but data reaches the resource row.
  const copy: unknown = JSON.parse(json);
  return isPlainObject(copy) ? Object.freeze(copy) : null;
}

function checkPatch(value: unknown): StepPatch | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => !PATCH_KEYS.has(key))) return null;
  const out: {
    state?: StepPatch["state"];
    awsName?: string;
    configMerge?: StepPatch["configMerge"];
  } = {};
  if ("state" in value) {
    const known = RESOURCE_STATES.find((s) => s === value.state);
    if (known === undefined) return null;
    out.state = known;
  }
  if ("awsName" in value) {
    const name = value.awsName;
    if (typeof name !== "string" || !AWS_NAME.test(name)) return null;
    out.awsName = name;
  }
  if ("configMerge" in value) {
    const merge = checkConfigMerge(value.configMerge);
    if (merge === null) return null;
    out.configMerge = merge;
  }
  return Object.freeze(out);
}

// The runner's check of whatever an adapter returned. Whether awsName belongs to this resource is
// not known here; the runner checks it.
export function checkStepResult(value: unknown, now: Date): StepResult | null {
  if (!isPlainObject(value)) return null;
  const kind = value.kind;
  let patch: StepPatch | undefined;
  if (value.patch !== undefined) {
    const checked = checkPatch(value.patch);
    if (checked === null) return null;
    patch = checked;
  }
  if (kind === "done") return stepDone(patch);
  if (kind !== "next" && kind !== "wait") return null;
  const step = value.step;
  if (typeof step !== "string" || !STEP_NAME.test(step)) return null;
  if (kind === "next") return stepNext(step, patch);
  const until = value.until;
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) return null;
  const earliest = now.getTime();
  const latest = earliest + MAX_WAIT_SECONDS * 1000;
  const clamped = new Date(Math.min(Math.max(until.getTime(), earliest), latest));
  return stepWait(step, clamped, patch);
}
