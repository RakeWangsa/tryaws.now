<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 126-200. Change the plan, then run pnpm spec:split. -->

## C. Set up Claude Code for speed

### C.1 One-time setup per machine

1. Install or update Claude Code, sign in, and open the repository folder once with `claude` to accept workspace trust.
2. Run the bootstrap prompt (E.1) on one machine only. Everyone else pulls the result.
3. Run `/permissions` and confirm the project rules loaded. Run `/sandbox` and turn the sandbox on. Run `/hooks` and confirm the three hooks of Appendix Q are listed.
4. Run `/context` and confirm `CLAUDE.md` is loaded and small.
5. Optional plugins through `/plugin`: a TypeScript code intelligence plugin, and Superpowers if the team already uses it (its planning, test-first, worktree and review skills fit the loop of C.3).

### C.2 Permission modes by activity

| Activity | Mode | How |
| --- | --- | --- |
| Planning a task | Plan | `claude --permission-mode plan`, or `Shift+Tab` until the status bar shows plan mode. `Ctrl+G` opens the plan in an editor |
| Implementing a task | Auto, with the sandbox on and the allow and deny rules of Appendix Q | Default from v2.1.283, or `--permission-mode auto` |
| Unattended batch work (for example translating message files) | `dontAsk` with an explicit tool list | `claude -p "<prompt>" --allowedTools "Read,Edit,Bash(pnpm test *)" --permission-mode dontAsk` |
| Never | `bypassPermissions` | Disabled in project settings |

Deny rules and hooks are guard rails. The real boundary is what the AWS profile can reach (staging and the test pool only) and what branch protection allows.

### C.3 The loop for every task

1. Start a fresh session in its own worktree: `claude --worktree wp3-t1 --permission-mode plan`. The worktree lives in `.claude/worktrees/wp3-t1/` on branch `worktree-wp3-t1`. Run `pnpm install` there.
2. Type `/wp-start WP3-T1`. Claude reads the task row, the spec files named for its work package and the last entries of `JOURNEY.md`, then writes a plan: files, interfaces consumed and produced, tests, open questions.
3. Read the plan. Fix it or approve it. Leave plan mode.
4. Claude writes the failing tests first, runs them, implements, and runs them until they pass. For long tasks set the proof as a `/goal` condition so Claude keeps going until it holds.
5. Claude runs `pnpm verify --task WP3-T1` and shows the output.
6. Claude asks the matching reviewer subagent (Appendix S) to review the diff in a fresh context, fixes what affects correctness or the spec, and ignores style opinions.
7. Claude appends a `JOURNEY.md` entry, commits with the task id, pushes, and opens a pull request with `gh pr create`. It does not merge.
8. A human reviews. Money, auth, IAM and infrastructure paths need the lead's approval (CODEOWNERS). After merge, CI deploys staging.
9. `/clear` or close the session. Never start the next task in the same context.

### C.4 Context discipline

| Rule | Why |
| --- | --- |
| One task per session; `/clear` between tasks; name sessions with `/rename` | A full context makes Claude forget rules |
| Never ask Claude to read this whole file after bootstrap. Point it to `docs/spec/<file>` | The file is about 170 KB |
| Use subagents for investigation ("use a subagent to find how X is done") | Exploration stays out of the main context |
| After two failed corrections of the same problem, `/clear` and restart with a sharper prompt | Failed attempts pollute the context |
| Side questions with `/btw` | The answer does not enter history |
| `CLAUDE.md` contains this line: "When compacting, keep the task id, the list of changed files and the commands that prove the task" | Project-root `CLAUDE.md` is re-read after compaction |

### C.5 Parallel work

| Track | Owns | Typical sessions in parallel |
| --- | --- | --- |
| A, core and money | `packages/core`, `packages/db`, `packages/eps`, WP0, WP1, WP3 | 1 to 2 |
| B, provisioning | `packages/aws`, `functions/*`, WP4 to WP7 | 1 to 2 |
| C, identity and UI | `packages/auth`, `packages/ui`, `apps/web`, WPU, WP2, WPP, all screens | 2 |
| D, admin | `apps/admin`, WP8 | 1 |

- One worktree per task, named after the task id. `.worktreeinclude` copies `.env.local` into each new worktree; `.claude/worktrees/` is in `.gitignore`.
- A new worktree starts from the default branch on the remote. A task that needs work not yet merged waits for the merge, or its driver sets `"worktree": { "baseRef": "head" }` in `.claude/settings.local.json` and starts from the branch that has the work.
- A track never edits another track's package. It codes against the contract in Section F and, until the real function exists, against a typed stub with the same signature.
- A contract change is its own small pull request that updates Section F first.
- For mechanical changes across many files (message keys, renames) use `/batch <instruction>`.
- One person can drive two sessions. More than two per person lowers review quality.

### C.6 External tools

Prefer command line tools over MCP servers, because they cost less context: `gh` for GitHub, `aws` for read-only checks in staging, `npx sst` for deploys. No MCP server is required. If the team adds one (for example an AWS documentation server) add it with `claude mcp add --transport http <name> --scope project <url>` so it lands in `.mcp.json`, and connect only servers the team trusts: a server that returns outside content is a prompt injection path.

### C.7 Git and CI

| Rule | Detail |
| --- | --- |
| Branching | Trunk-based. One short-lived branch per task, squash merge, linear history |
| Pull request size | One task. If a diff passes about 600 changed lines outside generated files, split the task |
| CI on every pull request | Install, lint (with the import-boundary rule for R1), typecheck, unit tests, integration tests against a PostgreSQL container, secret scan, dependency audit, `pnpm verify --quick`, spec split in sync |
| Deploy | Merge to `main` deploys `staging` through an OIDC role in `tc-platform-stg`. Production deploys from a tag through an OIDC role in `tc-platform` after a manual approval in a protected GitHub environment |
| Migrations | Forward-only, run by the `migrator` function during deploy (R15) |
| Commit messages | `WP3-T1: <what changed>` |

