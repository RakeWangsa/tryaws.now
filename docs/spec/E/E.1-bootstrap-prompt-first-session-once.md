<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 220-249. Change the plan, then run pnpm spec:split. -->

### E.1 Bootstrap prompt (first session, once)

```text
Read TICON_CLOUD_MEGA_PLAN.md completely. This is the only session that reads it whole.

Then do task WP0-T1:
1. Create the monorepo skeleton of Section 5 (pnpm workspaces, TypeScript strict, ESLint with an
   import-boundary rule that enforces R1, Prettier, Vitest). Exclude .claude/worktrees/ in the ESLint, Vitest,
   Playwright and TypeScript configs: those tools do not read .gitignore.
2. Create CLAUDE.md, .claude/settings.json, the hook scripts, .claude/rules/, .claude/skills/,
   .claude/agents/, .worktreeinclude, .gitignore, .github/CODEOWNERS (owned by the lead and the second reviewer: money, auth, IAM and infrastructure paths including infra/ and sst.config.ts, and the kit: .claude/, CLAUDE.md, .github/, scripts/verify.mjs, scripts/split-plan.mjs, verify/), JOURNEY.md and the pull request template exactly
   from Appendices P to T. Write .claude/settings.json after step 4, as the last kit file, so its hooks
   do not run before scripts/verify.mjs exists.
3. Write scripts/split-plan.mjs and run it so docs/spec/ holds one file per section of this plan,
   each with a "GENERATED, do not edit" header. File name: <id>-<slug>.md, where the id is the
   section letter or the two-digit section number and the slug is the heading in lower case, with every run of
   characters outside a-z and 0-9 replaced by one hyphen and no hyphen at either end (E-backlog-and-prompts.md,
   08-pricing-engine.md, 09-wallet-ledger-and-eps.md). A section over 150 lines also gets a
   folder <id>/ with one file per subsection. docs/spec/INDEX.md lists every file with its heading.
   A heading inside a fenced code block is not a section boundary.
4. Write scripts/verify.mjs and verify/baseline.json as Section G specifies. Fill the baseline
   from this plan: the pricing vectors of Section 8, the tables of Section 7, the routes and
   priorities of Section 16, the theme allow-list of 16.3, the secret names of B.3.
5. Add the CI workflow of C.7.
6. Run pnpm verify --gate M0 and show the output. Open a pull request, run gh pr checks --watch
   and show the result. Stop.

Do not create application code, AWS resources or migrations in this task.
```

