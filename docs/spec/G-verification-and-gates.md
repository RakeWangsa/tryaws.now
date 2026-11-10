<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "G. Verification and gates". Change the plan, then run pnpm spec:split. -->

## G. Verification and gates

`scripts/verify.mjs` is the single check that people and Claude Code run. It reads `verify/baseline.json` (facts copied from this plan) and reports pass or fail with evidence.

| Command | Runs | Used by |
| --- | --- | --- |
| `pnpm verify --quick` | Lint, typecheck and unit tests of changed packages. Under 60 seconds | The Stop hook, CI |
| `pnpm verify --task <id>` | The quick checks plus the proof of that task | Step 5 of the loop |
| `pnpm verify --gate <M0..M7>` | Every proof of the work packages in that gate, plus the gate's own checks against staging | The lead at 21:00, CI nightly |

Contract of the script: exit code 0 only when every check passed; a table of checks with pass or fail on stdout; `verify/report-<name>.json` with, for each check, the command, the exit code and the last lines of output. A check that cannot run counts as failed (R16). The baseline holds no secrets.

| Gate | When | Passes when |
| --- | --- | --- |
| M0 | Wed 11, morning | Repository kit exists; `pnpm verify --quick` passes; spec split in sync; the format check (`pnpm format:check`) passes. The lead merges the kit pull request only when its CI run is green |
| M1 | Wed 11, 21:00 | Staging deployed; database private; schema and pricing vectors pass; sign-up to KYC submission works; UI gallery passes; a signed-in customer sees the real catalog in taka |
| M2 | Thu 12, 21:00 | A real top-up credits exactly once and the replay and forgery tests pass; a paid order produces a server reachable by SSH; UI review done with Moshiur |
| M3 | Fri 13, 21:00 | Server features complete; one instance passes the whole lifecycle on the test clock; notifications send |
| M4 | Sat 14, 21:00 | Gate A adapters pass their cycles; admin P0 screens work; public P0 pages live on staging |
| M5 | Sun 15, 21:00 | Gate B adapters pass; metering runs; reconciler reports zero unexplained resources and cost variance under 2% |
| M6 | Mon 16, 18:00 | Every Section 15 item has evidence; go/no-go list of Section K is full; beta payments verified |
| M7 | Tue 17, launch | Flags set as decided; alarms deliver; on-call confirmed; first-day report produced |

A gate that fails is finished the next morning before new work starts.

