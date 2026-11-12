import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_TIMES, RACE_TESTS, parseRepeatArgs, repeatRuns } from "./test-repeat.mjs";

const root = resolve(import.meta.dirname, "../..");

it("runs five times by default, and every listed test file exists", () => {
  expect(DEFAULT_TIMES).toBe(5);
  expect(parseRepeatArgs([]).times).toBe(5);
  for (const file of RACE_TESTS) expect(existsSync(resolve(root, file)), file).toBe(true);
  expect(new Set(RACE_TESTS).size).toBe(RACE_TESTS.length);
});

it("reads --times and passes other arguments to vitest", () => {
  expect(parseRepeatArgs(["--times", "3"]).times).toBe(3);
  expect(parseRepeatArgs(["--times=2", "--", "--reporter=dot"])).toEqual({
    times: 2,
    vitestArgs: ["run", ...RACE_TESTS, "--reporter=dot"],
  });
  for (const bad of ["0", "x", "1000", "-1", ""])
    expect(() => parseRepeatArgs(["--times", bad])).toThrow("--times needs a whole number");
  expect(() => parseRepeatArgs(["--times"])).toThrow("--times needs");
});

it("stops at the first failing run and returns its code", async () => {
  const codes = [0, 0, 7, 0, 0];
  const seen = [];
  const code = await repeatRuns({ times: 5, vitestArgs: ["run"] }, async (args) => {
    seen.push(args);
    return codes[seen.length - 1];
  });
  expect(code).toBe(7);
  expect(seen).toHaveLength(3);
});

it("returns 0 only after every run passed", async () => {
  let runs = 0;
  const lines = [];
  const code = await repeatRuns(
    { times: 4, vitestArgs: [] },
    async () => {
      runs++;
      return 0;
    },
    (l) => lines.push(l),
  );
  expect(code).toBe(0);
  expect(runs).toBe(4);
  expect(lines.at(-1)).toBe("test:repeat 4 of 4 runs passed");
});
