#!/usr/bin/env bash
# @intent Ensure a per-env AWS SSO/profile session exists (do not run aws configure)
set -euo pipefail

ENV="${THONNAS_ENV:-}"
PROFILE="${AWS_PROFILE:-${AWS_SSO_PROFILE:-}}"

if [[ "${THONNAS_INFRA_BOOTSTRAP_SKIP_AWS:-}" == "1" ]]; then
  echo "Skipping AWS bootstrap (THONNAS_INFRA_BOOTSTRAP_SKIP_AWS=1)"
  exit 0
fi

if command -v aws >/dev/null 2>&1 && aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS identity already available${PROFILE:+ (profile $PROFILE)} for env ${ENV:-unknown}"
  exit 0
fi

if [[ -n "$PROFILE" ]] && command -v aws >/dev/null 2>&1; then
  echo "Logging in with AWS SSO profile ${PROFILE} for env ${ENV:-unknown}"
  aws sso login --profile "$PROFILE"
  exit $?
fi

echo "No AWS session for env ${ENV:-unknown}."
echo "Set AWS_PROFILE to the SSO profile for this environment, then re-run:"
echo "  aws sso login --profile <profile>"
echo "Do not use a generic aws configure for pipeline bootstrap."
exit 1

