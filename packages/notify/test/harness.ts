import type { Clock } from "@tc/core";
import type { InMemorySmsProvider } from "../sms/fake";

// A plainly fake key, built at run time (R3).
export const PEPPER = "unit-test-hash-key-".padEnd(48, "k");

export interface TestClock extends Clock {
  set(iso: string): void;
  advanceSeconds(seconds: number): void;
}

export function fixedClock(iso = "2026-11-11T10:00:00.000Z"): TestClock {
  let current = new Date(iso).getTime();
  return {
    now: () => new Date(current),
    set: (next) => {
      current = new Date(next).getTime();
    },
    advanceSeconds: (seconds) => {
      current += seconds * 1000;
    },
  };
}

// The first six-digit run in the last text sent to `to`.
export function lastCode(sms: InMemorySmsProvider, to: string): string {
  const texts = sms.sent.filter((m) => m.to === to);
  const last = texts[texts.length - 1];
  const found = last === undefined ? null : /[0-9]{6}/.exec(last.text);
  if (found === null) throw new Error("lastCode: no code was sent to that number");
  return found[0];
}

let phoneCounter = 0;
// A different valid local number on every call.
export function freshPhone(): string {
  phoneCounter += 1;
  return "0171" + String(phoneCounter).padStart(7, "0");
}

let ipCounter = 0;
// A different documentation-range address on every call (198.51.100.1 to .250).
export function freshIp(): string {
  ipCounter = (ipCounter % 250) + 1;
  return `198.51.100.${ipCounter}`;
}
