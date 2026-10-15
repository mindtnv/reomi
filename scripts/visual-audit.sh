#!/usr/bin/env bash
# Capture production screenshots for a design-system audit.
# Requires E2E_EMAIL and E2E_PASSWORD. Does not start local servers and does not sign up.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ ! "${E2E_EMAIL:-}" =~ [^[:space:]] || ! "${E2E_PASSWORD:-}" =~ [^[:space:]] ]]; then
  echo "E2E_EMAIL or E2E_PASSWORD is unset. Refusing to run the production visual audit." >&2
  exit 1
fi

export E2E_TARGET=prod
export E2E_EVIDENCE_DIR="${E2E_EVIDENCE_DIR:-$root/e2e/artifacts/visual}"
mkdir -p "$E2E_EVIDENCE_DIR"

if [[ ! -x node_modules/.bin/playwright ]]; then
  bun install
fi
if [[ -n "${CI:-}" ]]; then
  bunx playwright install --with-deps chromium
else
  bunx playwright install chromium
fi

secret_file="$(mktemp)"
export E2E_SECRET_FILE="$secret_file"
export PLAYWRIGHT_NO_COPY_PROMPT=1
if [[ -n "${CI:-}" ]]; then
  echo "::add-mask::${E2E_PASSWORD}"
fi

set +e
bunx playwright test --config=playwright.visual-audit.config.ts
playwright_status=$?
set -e

scan_status=0
if [[ ! -s "$secret_file" ]]; then
  echo "visual audit did not record a password for the artifact scan" >&2
  scan_status=1
else
  bun e2e/secret-scan-cli.ts || scan_status=$?
fi
rm -f "$secret_file"
if [[ "$scan_status" -ne 0 ]]; then
  exit "$scan_status"
fi
exit "$playwright_status"
