#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "${E2E_TARGET:-}" == "prod" ]]; then
  if [[ ! "${E2E_EMAIL:-}" =~ [^[:space:]] || ! "${E2E_PASSWORD:-}" =~ [^[:space:]] ]]; then
    echo "::warning::E2E_EMAIL or E2E_PASSWORD is unset. Skipping production smoke."
    exit 0
  fi
  if [[ ! -x node_modules/.bin/playwright ]]; then
    bun install
  fi
  if [[ -n "${CI:-}" ]]; then
    bunx playwright install --with-deps chromium
  else
    bunx playwright install chromium
  fi
  exec bunx playwright test
fi

port_busy() {
  local port="$1"
  (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1
}

for port in 3000 3001; do
  if port_busy "$port"; then
    echo "port $port is already in use. Refusing to start a second Reomi." >&2
    exit 1
  fi
done

compose() {
  if docker info >/dev/null 2>&1; then
    docker compose "$@"
  else
    sudo -n docker compose "$@"
  fi
}

created_env=0
started_pg=0
evidence="$root/e2e/artifacts"
mkdir -p "$evidence"
log="$evidence/dev-server.log"
pidfile="$evidence/dev.pid"

cleanup() {
  status=$?
  trap - EXIT
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile")"
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 -- -"$pid" 2>/dev/null || true
  fi
  if [[ "$created_env" == 1 ]]; then
    rm -f "$root/.env"
  fi
  if [[ "$started_pg" == 1 ]]; then
    compose stop postgres || true
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ ! -f "$root/.env" ]]; then
  cp "$root/.env.example" "$root/.env"
  created_env=1
fi

if ! compose ps --status running --format '{{.Service}}' postgres | grep -qx postgres; then
  started_pg=1
fi
compose up -d --wait postgres
bun run db:migrate:apply

if [[ ! -x node_modules/.bin/playwright ]]; then
  bun install
fi
if [[ -n "${CI:-}" ]]; then
  bunx playwright install --with-deps chromium
else
  bunx playwright install chromium
fi

setsid bun run dev >"$log" 2>&1 &
echo $! >"$pidfile"

ready=0
for _ in $(seq 1 180); do
  if curl -fsS -o /dev/null http://localhost:3000/ready && curl -fsS -o /dev/null http://localhost:3001/auth/sign-in; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" != 1 ]]; then
  echo "timed out waiting for http://localhost:3000/ready and http://localhost:3001/auth/sign-in" >&2
  tail -n 80 "$log" >&2 || true
  exit 1
fi

bash "$root/scripts/verify-reomi-doctor.sh"
export E2E_EVIDENCE_DIR="$evidence"
bunx playwright test
