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
