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
