<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 128-203. Change the plan, then run pnpm spec:split. -->

## C. Set up Claude Code for speed

### C.1 One-time setup per machine

1. Install or update Claude Code, sign in, and open the repository folder once with `claude` to accept workspace trust.
2. Run the bootstrap prompt (E.1) on one machine only. Everyone else pulls the result.
3. Run `/permissions` and confirm the project rules loaded. Run `/sandbox` and confirm the sandbox is on (the project settings turn it on and list the commands that run outside it). Run `/hooks` and confirm the three hooks of Appendix Q are listed.
4. Run `/context` and confirm `CLAUDE.md` is loaded and small.
5. Optional plugins through `/plugin`: a TypeScript code intelligence plugin, and Superpowers if the team already uses it (its planning, test-first, worktree and review skills fit the loop of C.3).

### C.2 Permission modes by activity

| Activity | Mode | How |
| --- | --- | --- |
| Planning a task | Plan | `claude --permission-mode plan`, or `Shift+Tab` until the status bar shows plan mode. `Ctrl+G` opens the plan in an editor |
| Implementing a task | Auto, with the sandbox on and the allow and deny rules of Appendix Q | Default from v2.1.283, or `--permission-mode auto` |
| Unattended batch work (for example translating message files) | `dontAsk` with an explicit tool list | `claude -p "<prompt>" --allowedTools "Read,Edit,Bash(pnpm test *)" --permission-mode dontAsk` |
| Never | `bypassPermissions` | Disabled in project settings |

Deny rules and hooks are guard rails. The real boundary is what the AWS profile can reach (staging and the test pool only) and what branch protection allows. With the sandbox on, the `Read` and `Edit` deny rules also bind every sandboxed command: a sandboxed `pnpm spec:split` cannot write `docs/spec/`, a sandboxed test cannot read `.env.local`, and a sandboxed `git merge` over those paths fails with `unable to unlink old`. The `sandbox.excludedCommands` list of Appendix Q runs these commands outside the sandbox.

### C.3 The loop for every task

1. Run `git fetch origin` in the main checkout, then start a fresh session in its own worktree: `claude --worktree wp3-t1 --permission-mode plan`. The worktree lives in `.claude/worktrees/wp3-t1/` on branch `worktree-wp3-t1`. Run `pnpm install` there.
2. Type `/wp-start WP3-T1`. Claude reads the task row, the spec files named for its work package and the last entries of `JOURNEY.md`, then writes a plan: files, interfaces consumed and produced, tests, open questions.
3. Read the plan. Fix it or approve it. Leave plan mode.
4. Claude writes the failing tests first, runs them, implements, and runs them until they pass. For long tasks set the proof as a `/goal` condition so Claude keeps going until it holds.
5. Claude runs `pnpm verify --task WP3-T1` and shows the output.
6. Claude asks the matching reviewer subagent (Appendix S) to review the diff in a fresh context, fixes what affects correctness or the spec, and ignores style opinions.
7. Claude appends a `JOURNEY.md` entry, commits with the task id, pushes, and opens a pull request with `gh pr create`. It does not merge.
8. A human reviews. Money, auth, IAM and infrastructure paths need the lead's approval (CODEOWNERS). After merge, CI deploys staging.
9. `/clear` or close the session. Never start the next task in the same context.
10. Keep the worktree until the pull request is merged. For review changes run `claude --worktree wp3-t1 --resume` (on another machine `claude --worktree "#<pr number>"`), fix, run `pnpm verify --task`, push. Remove the worktree after the merge.

### C.4 Context discipline

| Rule | Why |
| --- | --- |
| One task per session; `/clear` between tasks; name sessions with `/rename` | A focused context gives better answers and costs less |
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
- A new worktree starts from the default branch on the remote. Claude Code fetches the default branch only when the repository has not been fetched for 24 hours, so run `git fetch origin` first. A task that needs work not yet merged waits for the merge, or its driver creates the worktree with git from the branch that has the work (`git worktree add .claude/worktrees/wp3-t2 -b worktree-wp3-t2 worktree-wp3-t1`) and starts `claude` inside it. `worktree.baseRef` cannot name a branch, and in `.claude/settings.local.json` it would apply to every later worktree.
- A track edits another track's package only where its task row in E.3 puts the work there (for example `functions/catalog-sync` for track A and `packages/core/operations` for track B), and notes it in `JOURNEY.md` (Section 14). Otherwise it codes against the contract in Section F and, until the real function exists, against a typed stub with the same signature. Track B writes `packages/core/{operations,capacity,orders,lifecycle}` and `packages/notify`, with migrations reviewed by track A; each `functions/` folder belongs to the track whose task creates it.
- A contract change is its own small pull request that updates Section F first.
- A mechanical change across many files (message keys, renames) is its own task with one pull request, done in one session. `/batch` opens one pull request per unit, so use it only when the lead agrees, and never for shared files such as message catalogs.
- One person can drive two sessions. More than two per person lowers review quality.

### C.6 External tools

Prefer command line tools over MCP servers, because they cost less context: `gh` for GitHub, `aws` for read-only checks in staging, `npx sst` for deploys. No MCP server is required. If the team adds one (for example an AWS documentation server) add it with `claude mcp add --transport http <name> --scope project <url>` so it lands in `.mcp.json`, and connect only servers the team trusts: a server that returns outside content is a prompt injection path.

### C.7 Git and CI

| Rule | Detail |
| --- | --- |
| Branching | Trunk-based. One short-lived branch per task, squash merge, linear history |
| Pull request size | One task. If a diff passes about 600 changed lines outside generated files, split the task |
| CI on every pull request | Install, lint (with the import-boundary rule for R1), typecheck, unit tests, integration tests against a PostgreSQL container, secret scan, dependency audit, `pnpm verify --quick`, spec split in sync |
| Deploy | Merge to `main` deploys `staging` through an OIDC role in `tc-platform-stg`. Production deploys from a tag through an OIDC role in `tc-platform` after a manual approval in a protected GitHub environment. A tag ruleset lets only the lead and DevOps create `v*` tags; the workflow fails unless the tagged commit is on `main`; the environment `production` accepts only `v*` tags and needs a reviewer other than the tagger. The `tc-platform` role trusts only `sub` = `repo:<org>/<repo>:environment:production`, the staging role only `repo:<org>/<repo>:ref:refs/heads/main`. CODEOWNERS (E.1) covers, among its other paths, `.github/`, `infra/`, `sst.config.ts` and `.claude/` |
| Migrations | Forward-only, run by the `migrator` function during deploy (R15) |
| Commit messages | `WP3-T1: <what changed>` |

