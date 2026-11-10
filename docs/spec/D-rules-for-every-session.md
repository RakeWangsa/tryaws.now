<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "D. Rules for every session". Change the plan, then run pnpm spec:split. -->

## D. Rules for every session

These go into `CLAUDE.md` (Appendix P).

1. Work on exactly one task id. If the task needs something outside its scope, write it in `JOURNEY.md` and stop.
2. Tests first for logic in `packages/core`, `packages/db`, `packages/eps` and `packages/aws`. A task without a passing proof is not done.
3. Show evidence: the command and its output. Never write "should work".
4. Stop and write a "Needs decision" entry instead of guessing when any of these appear: a rule of Section 2 or 16.2 blocks the task; a price, tax or wallet rule is unclear; an AWS API behaves differently from the spec; data would be deleted; a new dependency for auth or crypto is needed; legal wording is needed; anything would run against production.
5. Never read or print secrets. Never run `sst secret`. Never deploy to production. Never touch the management account.
6. Never edit `design/mockup/`, generated `docs/spec/` files, or a migration that is already merged.
7. Use the contracts of Section F as written. Change them only through a pull request that edits this file.
8. Customer-facing text follows Section 16.13: AWS is named with the exact statements; account ids, ARNs and raw AWS errors are never shown.
9. Check AWS, SST, Next.js, Cognito and EPS details against current documentation before using them. Record each VERIFY result in `JOURNEY.md`.

