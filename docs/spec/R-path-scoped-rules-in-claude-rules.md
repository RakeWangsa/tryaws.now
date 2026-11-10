<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 1850-1884. Change the plan, then run pnpm spec:split. -->

## R. Path-scoped rules in `.claude/rules/`

Each file starts with a `paths:` list in YAML frontmatter and loads only when Claude works on matching files. The body is the full text of the named rules, copied verbatim from Section 2 or Section 16.2, followed by the pointers.

| File | `paths` | Body |
| --- | --- | --- |
| `money.md` | `packages/core/pricing/**`, `packages/core/ledger/**`, `packages/core/orders/**`, `packages/eps/**`, `functions/payments-sweeper/**` | R4, R5, R6, R7, R16 in full. Pointers: `docs/spec/08`, `docs/spec/09`. "Run the pricing vectors after every change in pricing" |
| `aws.md` | `packages/aws/**`, `functions/**`, `infra/**` | R1, R2, R3, R11, R12, R13 in full. Pointers: `docs/spec/03`, `docs/spec/06`, `docs/spec/10` |
| `data.md` | `packages/db/**` | R5, R8, R15 in full. "Every new repository method takes the tenant scope and gets a cross-tenant test" |
| `ui.md` | `apps/**`, `packages/ui/**`, `packages/notify/**`, `content/**` | U1 to U13 in full. Pointers: `docs/spec/16` files for tokens, kit, statements and names |
| `admin.md` | `apps/admin/**` | R10 in full. Pointer: `docs/spec/16` (16.12) |
| `lifecycle.md` | `packages/core/lifecycle/**`, `functions/scheduler/**` | R4, R5, R7, R13, R16 in full. Pointer: `docs/spec/11`. "Time comes from the injected Clock only" |
| `server.md` | `apps/**`, `functions/**`, `packages/auth/**`, `packages/core/operations/**`, `**/package.json`, `pnpm-lock.yaml` | R6, R7, R8, R9, R14, R16, R17 in full. Pointers: `docs/spec/02`, `docs/spec/06` |

Example, `.claude/rules/money.md`:

```markdown
---
paths:
  - "packages/core/pricing/**"
  - "packages/core/ledger/**"
  - "packages/core/orders/**"
  - "packages/eps/**"
  - "functions/payments-sweeper/**"
---

# Money rules

(R4, R5, R6, R7 and R16, copied verbatim from Section 2)

- Specification: docs/spec/08-pricing-engine.md and docs/spec/09-wallet-ledger-and-eps.md
- Run the pricing vectors after every change in packages/core/pricing.
- A change to a posting rule or to the EPS credit rule needs a "Needs decision" entry first.
```

