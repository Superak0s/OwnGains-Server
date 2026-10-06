#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# .env is dotenv syntax, not bash (unquoted spaces in ALLOWED_ORIGINS), so read the one key instead of sourcing it
if [ -z "${SONAR_TOKEN:-}" ] && [ -f .env ]; then
  SONAR_TOKEN="$(grep -E '^SONAR_TOKEN=' .env | tail -n1 | cut -d= -f2- | tr -d '\r"'"'"'' || true)"
fi
if [ -z "${SONAR_TOKEN:-}" ]; then
  echo "SONAR_TOKEN is not set" >&2
  exit 1
fi

npx @sonar/scan \
  -Dsonar.host.url=https://sonarqube.superak0s.com \
  -Dsonar.token="$SONAR_TOKEN" \
  -Dsonar.projectKey=OwnGains-Server \
  -Dsonar.analysisCache.enabled=false
