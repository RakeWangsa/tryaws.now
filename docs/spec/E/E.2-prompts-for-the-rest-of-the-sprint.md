<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 243-255. Change the plan, then run pnpm spec:split. -->

### E.2 Prompts for the rest of the sprint

| Use | What to type |
| --- | --- |
| Start a task | `/wp-start WP3-T1` in a fresh worktree session started in plan mode |
| Prove a task or a gate | `/wp-verify WP3-T1` or `/wp-verify M2` |
| End a session with unfinished work | `/handoff` |
| Second opinion on money code | `Use the money-reviewer subagent to review this diff against docs/spec/08 and docs/spec/09. Report only gaps that affect correctness or the spec.` |
| Second opinion on security | `Use the security-reviewer subagent on this diff. Check R1 to R17 and the cross-tenant test for every new endpoint.` |
| Check a screen against the plan | `Use the spec-checker subagent: compare apps/web/app/servers against docs/spec/16 rows for /servers. List missing states, actions and messages.` |
| Answer a blocked task | Paste the decision under the item in `JOURNEY.md`, then `claude --worktree <task> --resume` and say: `The decision for item N is recorded in JOURNEY.md. Continue.` |
| Explain a failure | `The gate M2 fails with this output: <paste>. Find the root cause with a subagent, write a failing test that reproduces it, then fix it.` |

