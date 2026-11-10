<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 637-645. Change the plan, then run pnpm spec:split. -->

## 0. How Claude Code uses this specification

1. This is Part 3 of the mega plan. Work starts from Part 1: the bootstrap prompt of Section E.1 once, then one task per session with `/wp-start <task id>`.
2. Task WP0-T1 creates `CLAUDE.md`, the path-scoped rules in `.claude/rules/` and the generated `docs/spec/` files from this file (Appendices P to T). `CLAUDE.md` stays under 200 lines; the long text stays here.
3. Work package by work package (Section 14), task by task (Section E.3). A task is done only when its proof passes. A work package is done only when its acceptance tests pass.
4. Never weaken a rule in Section 2 or Section 16.2 to make a task pass. If a rule blocks the work, stop and write the question under "Needs decision" in `JOURNEY.md`.
5. Check AWS, SST and EPS API details against current documentation before use. Items marked VERIFY must be proven in the staging pool account and the result recorded in `JOURNEY.md`.
6. This file is the master. Change it in a pull request, then run `pnpm spec:split` so `docs/spec/` follows.

