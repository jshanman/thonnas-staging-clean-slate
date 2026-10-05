#!/usr/bin/env bash
# @intent Wrapper for AWS MCP server (Docker) — expands $HOME so volume mount works on Windows/Unix
set -e
AWS_DIR="${HOME}/.aws"
[[ -n "$USERPROFILE" ]] && AWS_DIR="$USERPROFILE/.aws"
ENV_ARGS=()
if [ -n "${AWS_REGION:-}" ]; then
  ENV_ARGS+=(-e "AWS_REGION=${AWS_REGION}")
elif [ -n "${AWS_DEFAULT_REGION:-}" ]; then
  ENV_ARGS+=(-e "AWS_REGION=${AWS_DEFAULT_REGION}")
fi
exec docker run --rm -i \
  -v "$AWS_DIR:/app/.aws" \
  "${ENV_ARGS[@]}" \
  public.ecr.aws/awslabs-mcp/awslabs/aws-api-mcp-server:latest



