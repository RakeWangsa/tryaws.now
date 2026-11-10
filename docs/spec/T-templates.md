<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 1994-2021. Change the plan, then run pnpm spec:split. -->

## T. Templates

`JOURNEY.md` entry:

```markdown
## 2026-11-12 14:20 WP3-T1 (track A, <driver>)
Done: <what changed, one or two lines>
Proof: <command> -> <result>
VERIFY results: <item>: <what was observed>
Needs decision:
1. <question>. Options: <a>, <b>. Blocks: <task ids>.
Next: <task id or exact next step>
```

Pull request description:

```markdown
Task: WP3-T1
What changed:
Proof (command and output):
Spec sections implemented:
Contracts changed (Section F): none | <which>
Reviewer subagent result:
Risk if this is wrong:
```

Definition of done for a task: the proof passes and its output is in the pull request; `pnpm verify --quick` is green; the reviewer subagent has no open finding that affects correctness or the specification; new endpoints have a cross-tenant test; new text exists in `bn` and `en`; `JOURNEY.md` has the entry; a human approved the pull request.

