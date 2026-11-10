<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 28-46. Change the plan, then run pnpm spec:split. -->

## A. Read this first

What is being built: TiCON Cloud, a prepaid self-service cloud panel for Bangladesh. Every resource a customer buys is an Amazon Lightsail resource on AWS, and customers are told so openly. They pay in taka through EPS into a wallet and buy 30-day terms. Part 2 Section H has the product brief.

Three things make this build fast with Claude Code, and the rest of Part 1 sets them up:

| Lever | What it means here | Where |
| --- | --- | --- |
| Small context per session | One task per session. Claude Code reads the task row, the listed spec files and nothing else. `CLAUDE.md` is under 200 lines; the long text is this file, split into `docs/spec/` | C, E, Appendix P |
| A check Claude can run | Every task has a proof (a test or a command) and every day has a gate (`pnpm verify --gate M2`). Claude works until the check passes and shows the output | E, G |
| Parallel tracks that do not collide | Four tracks in separate git worktrees, joined by the contracts of Section F. Pull requests are small and reviewed by a second, fresh session before a human looks | C, F |

Order of work on the first morning:

1. Moshiur and DevOps complete Section B (what Claude Code needs).
2. One developer runs the bootstrap prompt of Section E.1. It creates the repository kit from the appendices.
3. Each track starts its first task with `/wp-start <task id>` (Section E.3).
4. At 21:00 the lead runs the day's gate (Section G) and Moshiur answers the open "Needs decision" items.

