<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md. Change the plan, then run pnpm spec:split. -->

# TiCON Cloud on AWS: MEGA PLAN

Version 1.0, 2026-11-11. Launch target: Tuesday 2026-11-17.
Owner: S M Moshiur Rahman, TiCON System Limited. Builder: Claude Code with the TiCON dev team.

This one file is the source of truth for the product, the launch and the build. It replaces `TICON_CLOUD_LIGHTSAIL_BUILD_PLAN.md`: the full text of that file (version 0.3) is Part 3 here, with the same section numbers.

| Part | Sections | What it holds | Who reads it |
| --- | --- | --- | --- |
| 1. Start here | A to G | What to give Claude Code, how to set it up for speed, the task backlog, the prompts, the contracts between tracks, the verification gates | Moshiur, every developer, Claude Code at bootstrap |
| 2. Product and launch | H to O | Product brief, metrics, day-by-day timeline, roles, go/no-go, go-to-market, operations, risks, roadmap | Moshiur, leads; Claude Code when a task needs it |
| 3. Build specification | 0 to 18 | Architecture, security rules, data model, pricing, wallet and EPS, provisioning, lifecycle, admin, work packages, screens | Claude Code, per task |
| 4. Appendices | P to U | Ready text for `CLAUDE.md`, settings, hooks, rules, skills, subagents, templates, glossary | Claude Code at bootstrap |

Changes against build plan 0.3, all made in this version:

| Where | Change |
| --- | --- |
| Part 1, Part 2, Part 4 | New |
| 3.1, 6.3 | The staging control plane moves to its own AWS account (`tc-platform-stg`), so developer machines and Claude Code never hold credentials that reach production |
| 3.2, 5, 9.3 | New function `invoice-renderer`: invoice PDFs are rendered from HTML by headless Chromium, because Bengali text needs real text shaping |
| 0, 2, 16.2 | `CLAUDE.md` stays short. Full rule text lives in path-scoped rule files and in generated `docs/spec/` files (Appendix P to S) |
| 4, 5 | CI and deploy row; `.claude/`, `docs/spec/`, `verify/` and `docs/runbooks/` in the layout |
| 14, 15, 17 | Pointers to the task backlog and the gates; one more security check; open items for roles and for Amazon SES production access |

# Part 1. Start here

# Part 2. Product and launch

# Part 3. Build specification

Sections 0 to 18 below are the build specification. Their numbers are stable: tasks, rules and the generated `docs/spec/` files refer to them.

# Part 4. Appendices

Task WP0-T1 creates these files as written. They follow the Claude Code documentation checked on 2026-11-11 (Appendix U). If a Claude Code release has changed a format, follow the current documentation and note the difference in `JOURNEY.md`.

