#!/usr/bin/env bash
# WPU-Z11: sets every SST secret of a stage (infra/lib/functions.ts ALL_SECRETS and DB_PASSWORD_SECRET)
# with `npx sst secret set`. Usage: scripts/golive/stage-secrets.sh <staging|production> [--force]
#
# Run by the owner in their own terminal, never by Claude Code or CI (docs/runbooks/go-live.md). Load the
# AWS credentials first with the pattern of JOURNEY.md (SST cannot read an `aws login` profile):
#   CREDS="$(aws configure export-credentials --profile your-aws-profile --format env)" && eval "$CREDS"
#   export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null; unset AWS_PROFILE
#
# Values:
#   internal keys and database passwords  random, `openssl rand -hex 32`, never shown
#   SmsApiKey (Gennet API token)          hidden prompt (read -rs), optional
#   SmsSenderId (not a secret)            visible prompt, optional: an empty answer sets nothing, the
#                                         stack's placeholder `not-configured` applies and SMS is off
#                                         (no request to Gennet; the phone OTP says SMS is unavailable)
#   EpsMerchantId, EpsStoreId, EpsUsername, EpsPassword, EpsHashKey
#                                         hidden prompt; an empty answer stores the literal
#                                         `not-configured`: the platform then has no EPS and every top-up
#                                         says "not available", nothing is sent to EPS (R6, R16)
#   FirstAdminSub (WPU-Z18, optional)     visible prompt: the Cognito `sub` (a UUID, not a secret) of the
#                                         first superadmin. Leave it empty until the Cognito admin exists:
#                                         an empty answer sets nothing (the stack's placeholder applies and
#                                         the migrator writes no admin); a value that is not a UUID is
#                                         refused. docs/runbooks/go-live.md step 9.2.
# A secret that already has a value is skipped unless --force is given. Only the NAMES of the existing
# secrets are read (`sst secret list | cut -d= -f1`); values never reach the terminal or a file.
# A value is handed to sst on standard input (`sst secret set <name> < value`), never on the command
# line, so it does not appear in the process list. The script prints only the names it set or skipped.
set -euo pipefail
umask 077

readonly PLACEHOLDER="not-configured"

# Kept in step with infra/lib/functions.ts by tests/repo/golive.test.mjs.
readonly RANDOM_SECRETS="EpsLimitKey OrderDraftSecret AuthLimitKey OtpHashKey AdminIpLimitKey"
readonly DB_PASSWORD_SECRETS="DbPasswordWebRw DbPasswordAdminRw DbPasswordWorkerRw DbPasswordMigrator DbPasswordReportRo"
readonly EPS_SECRETS="EpsMerchantId EpsStoreId EpsUsername EpsPassword EpsHashKey"
readonly SMS_TOKEN_SECRET="SmsApiKey"
readonly SMS_SENDER_SECRET="SmsSenderId"
readonly FIRST_ADMIN_SECRET="FirstAdminSub"

die() {
  echo "stage-secrets: $1" >&2
  exit 1
}

usage() {
  die "usage: scripts/golive/stage-secrets.sh <staging|production> [--force]"
}

STAGE=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    staging | production)
      [[ -z "$STAGE" ]] || usage
      STAGE="$arg"
      ;;
    --force) FORCE=1 ;;
    *) usage ;;
  esac
done
[[ -n "$STAGE" ]] || usage

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v aws >/dev/null 2>&1 || die "the aws command is not installed"
command -v npx >/dev/null 2>&1 || die "the npx command is not installed"
command -v openssl >/dev/null 2>&1 || die "the openssl command is not installed"

# 1. Credentials must work, as exported keys (SST does not read an `aws login` profile). Fail closed.
if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  die "no exported AWS credentials in this terminal. Load them first (see the top of this script and docs/runbooks/go-live.md)"
fi
if ! ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"; then
  die "AWS credentials do not work (aws sts get-caller-identity failed); refusing"
fi
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || die "aws sts get-caller-identity gave no account id; refusing"

# infra/lib/stage.ts refuses the stage production outside the protected CI job for EVERY sst command,
# `sst secret` included. `sst secret` cannot deploy, so the two variables are set for those sst calls
# only, and only for production (Assumption recorded in the WPU-Z11 report).
# The wrapper runs `sst secret list` and `sst secret set` only; any other sst command is refused, so the
# guard variables can never reach a deploy, a remove or a diff from this script.
sst() {
  [[ "${1:-}" == secret && ( "${2:-}" == list || "${2:-}" == set ) ]] || die "only sst secret list and sst secret set are allowed here"
  if [[ "$STAGE" == "production" ]]; then
    CI=true TC_PRODUCTION_DEPLOY=ci-approved npx --no-install sst "$@"
  else
    npx --no-install sst "$@"
  fi
}

# 2. The names that already have a value (names only; the values are cut off in the pipe).
if ! EXISTING="$(sst secret list --stage "$STAGE" 2>/dev/null | cut -d= -f1)"; then
  die "could not list the secret names of ${STAGE}; refusing"
fi

has_value() {
  local name="$1" line
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ "$line" == "$name" ]] && return 0
  done <<<"$EXISTING"
  return 1
}

# set_secret <name> <value>: the value goes to sst on standard input.
set_secret() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || die "empty value for ${name}; refusing"
  if ! printf '%s' "$value" | sst secret set "$name" --stage "$STAGE" >/dev/null 2>&1; then
    die "sst secret set failed for ${name} (stage ${STAGE})"
  fi
  echo "set ${name}"
}

should_set() {
  local name="$1"
  if [[ "$FORCE" -eq 0 ]] && has_value "$name"; then
    echo "skipped ${name} (already set; --force replaces it)"
    return 1
  fi
  return 0
}

random_value() {
  openssl rand -hex 32
}

# 3. Random internal keys and database passwords.
for name in $RANDOM_SECRETS $DB_PASSWORD_SECRETS; do
  if should_set "$name"; then
    set_secret "$name" "$(random_value)"
  fi
done

# 4. The SMS gateway (Gennet), optional: the API token hidden, the sender id visible (not a secret). An empty
# answer (or the end of the input) sets nothing: the stack's placeholder `not-configured` applies
# (infra/stacks/secrets.ts), SMS is off, the phone OTP says SMS is unavailable and nothing is sent to Gennet.
if should_set "$SMS_TOKEN_SECRET"; then
  read -rs -p "Gennet API token for ${STAGE} (hidden; empty = SMS off): " SMS_TOKEN || SMS_TOKEN=""
  echo
  if [[ -z "$SMS_TOKEN" ]]; then
    echo "skipped ${SMS_TOKEN_SECRET} (empty: SMS stays off, the placeholder ${PLACEHOLDER} applies)"
  else
    set_secret "$SMS_TOKEN_SECRET" "$SMS_TOKEN"
  fi
  unset SMS_TOKEN
fi
if should_set "$SMS_SENDER_SECRET"; then
  read -r -p "SMS sender id (sid) for ${STAGE} (empty = SMS off): " SMS_SENDER || SMS_SENDER=""
  if [[ -z "$SMS_SENDER" ]]; then
    echo "skipped ${SMS_SENDER_SECRET} (empty: SMS stays off, the placeholder ${PLACEHOLDER} applies)"
  else
    set_secret "$SMS_SENDER_SECRET" "$SMS_SENDER"
  fi
  unset SMS_SENDER
fi

# 5. EPS: hidden prompts; empty stores the placeholder (EPS not configured).
for name in $EPS_SECRETS; do
  if should_set "$name"; then
    read -rs -p "${name} for ${STAGE} (hidden; empty = ${PLACEHOLDER}): " EPS_VALUE
    echo
    set_secret "$name" "${EPS_VALUE:-$PLACEHOLDER}"
    unset EPS_VALUE
  fi
done

# 6. WPU-Z18: the Cognito sub of the first superadmin, optional and last. An empty answer (or the end of
# the input) sets nothing. The value is checked here and again by the migrator, and never printed.
if should_set "$FIRST_ADMIN_SECRET"; then
  read -r -p "Cognito sub of the first superadmin for ${STAGE} (leave empty until the Cognito admin exists): " FIRST_ADMIN_SUB || FIRST_ADMIN_SUB=""
  if [[ -z "$FIRST_ADMIN_SUB" ]]; then
    echo "skipped ${FIRST_ADMIN_SECRET} (empty: leave empty until the Cognito admin exists)"
  elif [[ "$FIRST_ADMIN_SUB" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    set_secret "$FIRST_ADMIN_SECRET" "$(printf '%s' "$FIRST_ADMIN_SUB" | tr 'A-F' 'a-f')"
  else
    unset FIRST_ADMIN_SUB
    die "${FIRST_ADMIN_SECRET} is not a Cognito sub (a UUID); nothing set for it"
  fi
  unset FIRST_ADMIN_SUB
fi

echo "done: stage ${STAGE}"
