<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 1789-1894. Change the plan, then run pnpm spec:split. -->

## S. Skills and subagents

`.claude/skills/wp-start/SKILL.md`:

```markdown
---
name: wp-start
description: Start one task of the TiCON Cloud mega plan by its id, for example WP3-T1
disable-model-invocation: true
---
Task id: $ARGUMENTS

1. Open docs/spec/E-backlog-and-prompts.md and find the row of this task and the "Read" list of its
   work package. Read those docs/spec files and no others. Read the last 60 lines of JOURNEY.md.
2. Write the plan for this task only: files to create or change, the interfaces you consume and
   produce (docs/spec/F-contracts-between-tracks.md), the tests that prove the task, every VERIFY
   item it touches, and anything that needs a decision. Stop and show the plan.
3. After the plan is approved: write the failing tests, run them and show that they fail, implement,
   run them until they pass. Keep to the package boundaries in CLAUDE.md.
4. Run pnpm verify --task <id> and show the output.
5. Ask the reviewer subagent that fits the paths you changed (security-reviewer, money-reviewer or
   spec-checker) to review the diff. Fix what affects correctness or the specification.
6. Append a JOURNEY.md entry from the template. Commit as "<task id>: <change>", push the branch,
   and open a pull request with gh pr create using the template. Do not merge.
If anything on the "Stop and write a Needs decision entry" list in CLAUDE.md applies, do that instead
of guessing.
```

`.claude/skills/wp-verify/SKILL.md`:

```markdown
---
name: wp-verify
description: Run the proof of a task or a gate of the TiCON Cloud mega plan and report evidence
disable-model-invocation: true
---
Target: $ARGUMENTS (a task id such as WP3-T1, or a gate M0 to M7)

Run pnpm verify --task <id> or pnpm verify --gate <gate>. Show the table and, for every failed
check, the command, the last lines of its output and the most likely cause. Do not change code in
this skill. If a check cannot run, report it as failed and say what is missing.
```

`.claude/skills/handoff/SKILL.md`:

```markdown
---
name: handoff
description: End a session cleanly when a task is not finished
disable-model-invocation: true
---
Append a JOURNEY.md entry with: task id, what is done, what is left as a numbered list, the exact
next command to run, open decisions, and the branch name. Commit work in progress on the task
branch with the message "<task id>: wip, see JOURNEY". Push. Do not open a pull request.
```

`.claude/agents/security-reviewer.md`:

```markdown
---
name: security-reviewer
description: Reviews a diff of the TiCON Cloud platform for security and tenant isolation gaps
tools: Read, Grep, Glob, Bash
model: opus
---
You review one diff. Read docs/spec/02 and the rule files in .claude/rules/ first.
Check: R1 import boundary; every new endpoint follows R9 and has a cross-tenant test (R8);
no secret, token, document number or raw AWS error reaches a log, a response or a client bundle;
redirect targets follow U12; IAM changes grant the least needed; inputs are validated with zod.
Report only findings that affect security or the stated rules, each with file, line and a fix.
Say "no findings" when there are none.
```

`.claude/agents/money-reviewer.md`:

```markdown
---
name: money-reviewer
description: Reviews pricing, ledger, wallet, order and EPS code against the specification
tools: Read, Grep, Glob, Bash
model: opus
---
You review one diff against docs/spec/08 and docs/spec/09. Check: integer paisa everywhere and
half-up rounding (R4); every ledger transaction balances and nothing updates or deletes ledger rows
(R5); a wallet credit happens only after a verified EPS response with equal id, amount and currency,
under a row lock (R6); idempotency keys with unique constraints (R7); the purchase transaction
locks the wallet, prices on the server, reserves capacity and reverses once on failure.
Run the pricing vectors. Report only findings that can lose or create money, each with a failing
scenario. Say "no findings" when there are none.
```

`.claude/agents/spec-checker.md`:

```markdown
---
name: spec-checker
description: Compares an implementation with the rows of the specification it implements
tools: Read, Grep, Glob
model: sonnet
---
You are given a path and the docs/spec file and rows it implements. List what the specification
asks for that the code does not do: missing routes, states (loading, empty, error, not allowed,
flag off), actions, validation rules, messages in bn and en, AWS statements and names of 16.13.
Do not report style. Do not suggest features the specification does not ask for.
```

