<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 1706-1849. Change the plan, then run pnpm spec:split. -->

## Q. Settings, hooks and ignore files

`.claude/settings.json` (shared, checked in):

```json
{
  "permissions": {
    "allow": [
      "Bash(pnpm install)",
      "Bash(pnpm verify *)",
      "Bash(pnpm test *)",
      "Bash(pnpm lint *)",
      "Bash(pnpm typecheck *)",
      "Bash(pnpm db:up)",
      "Bash(pnpm db:migrate)",
      "Bash(pnpm spec:split)",
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(gh pr create *)",
      "Bash(gh pr view *)",
      "Bash(gh run view *)"
    ],
    "ask": [
      "Bash(npx sst deploy --stage staging*)",
      "Bash(git push *)",
      "Bash(aws *)"
    ],
    "deny": [
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(./**/*.pem)",
      "Edit(/design/mockup/**)",
      "Edit(/docs/spec/**)",
      "Bash(npx sst secret *)",
      "Bash(pnpm sst secret *)",
      "Bash(pnpm exec sst secret *)",
      "Bash(npx sst shell *)",
      "Bash(pnpm sst shell *)",
      "Bash(npx sst deploy --stage production*)",
      "Bash(npx sst remove *)",
      "Bash(git push --force*)",
      "Bash(git push origin main*)",
      "Bash(aws organizations *)",
      "Bash(aws iam *)"
    ],
    "disableBypassPermissionsMode": "disable"
  },
  "sandbox": {
    "enabled": true,
    "excludedCommands": ["docker *", "pnpm db:up", "pnpm db:migrate", "pnpm test *", "pnpm verify *", "pnpm spec:split", "gh *", "git fetch *", "git pull *", "git push *", "git merge *", "git rebase *", "npx sst *", "npx playwright *", "aws *"],
    "network": { "allowedDomains": ["registry.npmjs.org", "github.com", "*.githubusercontent.com"] }
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.sh", "onFailure": "block" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "f=$(jq -r '.tool_input.file_path // empty'); case \"$f\" in ''|*.md|*.mdx) exit 0 ;; esac; npx prettier --write --ignore-unknown \"$f\"" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop-check.sh" }
        ]
      }
    ]
  }
}
```

`.claude/hooks/protect-files.sh` (make it executable). Exit code 2 blocks the edit and sends the message to Claude:

```bash
#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
FILE_PATH="${FILE_PATH//\\//}"
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
block() { echo "Blocked: $1" >&2; exit 2; }

case "$FILE_PATH" in
  */design/mockup/*) block "design/mockup is a read-only reference" ;;
  */docs/spec/*)     block "docs/spec is generated. Edit TICON_CLOUD_MEGA_PLAN.md, then run pnpm spec:split" ;;
  */.env|*/.env.*)   block "env files are edited by people only" ;;
  */packages/db/migrations/*)
    ROOT=$(git -C "${CWD:-.}" rev-parse --show-toplevel 2>/dev/null)
    REL="${FILE_PATH#"$ROOT"/}"
    if [ -n "$ROOT" ] && git -C "$ROOT" cat-file -e "origin/main:$REL" 2>/dev/null; then
      block "this migration is already on main. Migrations are forward-only: add a new one"
    fi ;;
esac
exit 0
```

`.claude/hooks/stop-check.sh` (make it executable). It runs the quick check at the root of the worktree the session is in, at the end of every turn that leaves uncommitted changes, and skips it until `pnpm install` has run and `scripts/verify.mjs` exists:

```bash
#!/bin/bash
INPUT=$(cat)
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then exit 0; fi
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
ROOT=$(git -C "${CWD:-$CLAUDE_PROJECT_DIR}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0
if [ -z "$(git status --porcelain)" ] || [ ! -d node_modules ] || [ ! -f scripts/verify.mjs ]; then
  exit 0
fi
if ! OUT=$(pnpm -s verify --quick 2>&1); then
  echo "pnpm verify --quick failed. Fix this before stopping, or write what blocks you in JOURNEY.md:" >&2
  echo "$OUT" | tail -n 40 >&2
  exit 2
fi
exit 0
```

`.worktreeinclude` (copied into every new worktree; it holds local, non-secret settings such as the local database URL):

```text
.env.local
```

Lines to add to `.gitignore`:

```text
.claude/worktrees/
.claude/settings.local.json
CLAUDE.local.md
.env
.env.*
.sst/
verify/report-*.json
```

