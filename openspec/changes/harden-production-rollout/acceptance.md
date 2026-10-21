# Acceptance

- Coordinator and repository-contract tests: 24 passed, 0 failed (208 assertions). Covers failed preparation, API/web replacement, cancellation, uncertain responses, failed recovery, concurrent tag changes and termination after drain.
- Standalone coordinator and workspace TypeScript checks passed; ESLint passed. Strict OpenSpec: 33 items passed.
- Production preparation-only successfully pulled and ran both current `fe4c4b31d3890b7d2f1523030f72ca78a18b5c53` images on ru-anvgrp-1. Both components reported `running:healthy:excluded`, used the expected images and had no public domain. API/web tags were not patched and neither production app was stopped. The temporary service was deleted with image cleanup disabled; a fresh services list confirmed no preparation services remain.
- Coolify 4.4.6 rejects explicit `connect_to_docker_network` at service creation despite its inner schema; omitted uses its false default. Component status can include `:excluded`, which is accepted only after the healthy prefix.
- PR checks, release and production smoke are recorded after publication; deployment task remains open until actual release.
