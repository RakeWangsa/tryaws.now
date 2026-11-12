/* global AbortController */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { ABORT_SIGNALS, abortOnSignals } from "./abort-on-signals.mjs";

it("listens for SIGINT, SIGTERM and SIGHUP", () => {
  expect(ABORT_SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
});

it.each(ABORT_SIGNALS)("%s aborts the controller, and a second one is still handled", (name) => {
  const proc = new EventEmitter();
  const controller = new AbortController();
  abortOnSignals(controller, proc);
  expect(controller.signal.aborted).toBe(false);
  proc.emit(name);
  expect(controller.signal.aborted).toBe(true);
  // `on`, not `once`: the handler stays, so a repeated signal is never left without one.
  expect(proc.listenerCount(name)).toBe(1);
  expect(() => proc.emit(name)).not.toThrow();
});

it("the returned function removes the handlers", () => {
  const proc = new EventEmitter();
  const off = abortOnSignals(new AbortController(), proc);
  off();
  for (const name of ABORT_SIGNALS) expect(proc.listenerCount(name)).toBe(0);
});

// The real process: a command that gets a signal finishes by itself (so it can write its report);
// it is not killed by the signal.
it.each(ABORT_SIGNALS)(
  "a real process that gets %s ends by itself",
  async (name) => {
    const url = new URL("./abort-on-signals.mjs", import.meta.url).href;
    const code = [
      `import { abortOnSignals } from ${JSON.stringify(url)};`,
      "const c = new AbortController();",
      "abortOnSignals(c);",
      'c.signal.addEventListener("abort", () => {',
      '  process.stdout.write("aborted\\n");',
      "  setTimeout(() => process.exit(0), 20);",
      "});",
      'process.stdout.write("ready\\n");',
      "setTimeout(() => process.exit(9), 15000);",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    const result = new Promise((resolve) => child.on("exit", (c, s) => resolve({ c, s })));
    await new Promise((resolve) =>
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("ready")) resolve();
      }),
    );
    child.kill(name);
    const { c, s } = await result;
    expect(s).toBeNull();
    expect(c).toBe(0);
    expect(out).toContain("aborted");
  },
  20000,
);
