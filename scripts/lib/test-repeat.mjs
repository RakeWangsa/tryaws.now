// pnpm test:repeat [--times N] [-- extra vitest arguments]
// Runs the race-sensitive tests N times (default 5), one vitest run after the other, and stops at the
// first run that fails. A race that shows once in five runs is a bug, not noise (R7, R15).
export const DEFAULT_TIMES = 5;

// Tests that start concurrent callers against one database or one counter.
export const RACE_TESTS = [
  "packages/core/capacity/race.test.ts",
  "packages/db/test/tx.test.ts",
  "packages/db/test/operations.test.ts",
  "packages/db/test/capacity.test.ts",
  "packages/db/test/waitlist.test.ts",
  "packages/db/test/invoices-repo.test.ts",
  "packages/db/test/admin-wallets.test.ts",
  "packages/db/test/admin-audited-active.test.ts",
  "packages/eps/test/sweep.test.ts",
  "packages/eps/test/recheck.test.ts",
];

export function parseRepeatArgs(argv) {
  let times = DEFAULT_TIMES;
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--times" || arg.startsWith("--times=")) {
      const raw = arg === "--times" ? argv[++i] : arg.slice("--times=".length);
      if (!/^[1-9][0-9]{0,2}$/.test(raw ?? ""))
        throw new Error("--times needs a whole number from 1 to 999");
      times = Number(raw);
    } else extra.push(arg);
  }
  return { times, vitestArgs: ["run", ...RACE_TESTS, ...extra] };
}

// Runs `run(args)` (resolves to an exit code) `times` times; stops at the first failure.
export async function repeatRuns({ times, vitestArgs }, run, log = () => {}) {
  for (let n = 1; n <= times; n++) {
    log(`test:repeat run ${n} of ${times}`);
    const code = await run(vitestArgs);
    if (code !== 0) {
      log(`test:repeat run ${n} of ${times} failed with exit code ${code}`);
      return code;
    }
  }
  log(`test:repeat ${times} of ${times} runs passed`);
  return 0;
}
