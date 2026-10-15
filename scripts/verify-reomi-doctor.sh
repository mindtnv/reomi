#!/usr/bin/env bash
set -euo pipefail

fail=0

if curl -fsS -o /dev/null http://localhost:3000/ready; then
  echo "api ready http://localhost:3000/ready"
else
  echo "api not ready http://localhost:3000/ready" >&2
  fail=1
fi

if curl -fsS -o /dev/null http://localhost:3001/auth/sign-in; then
  echo "web ready http://localhost:3001/auth/sign-in"
else
  echo "web not ready http://localhost:3001/auth/sign-in" >&2
  fail=1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
pidfile="$root/e2e/artifacts/dev.pid"
if [[ -f "$pidfile" ]]; then
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "dev pid $pid alive"
  else
    echo "dev pid $pid is not alive" >&2
    fail=1
  fi
fi

exit "$fail"
