# Reomi production domain migration

Target: `https://app.reomi.ru` (web), `https://api.reomi.ru` (API).
The apex `reomi.ru` and `www` are outside this migration; no landing page is deployed here.

## Infrastructure and rollback baseline

- Coolify team: `8`; server: `ru-anvgrp-1`, `82.202.165.26`.
- API: `u6kweu7gzzw9kidpuq7i0n7y`. Current publish window tags both `ghcr.io/<owner>/neuronexus-api` and `ghcr.io/<owner>/reomi-api` with the same commit SHA. Coolify still selects the image repository; switching it to `reomi-api` is an operator step and is not done by this repository change.
- Web: `tmc5k98iayyj0g28qr7inbaj`. The same window publishes `ghcr.io/<owner>/neuronexus-web` and `ghcr.io/<owner>/reomi-web`. Application UUIDs stay unchanged.
- Both verified baseline image tags on 2026-09-21: `40c5833c66ae990e34fd2b2683f9266bab4aa77f`.
- Old web: `https://neuronexus.mihailantonov.pro`.
- Old API host `https://api.neuronexus.mihailantonov.pro` is a removable alias. It is not a supported endpoint. Do not document it as a compatibility promise. The old web host still redirects to `https://app.reomi.ru`.
- Existing S3 endpoint/public media base, database and auth secret remain unchanged.

Nonsecret routing/environment snapshots and the original bucket CORS are saved on the operator Mac under `~/.codex/reomi-domain-migration/`. Do not commit credentials or full environment dumps.

## Stage without cutting over

1. DNS must ultimately return A records for `app` and `api` pointing to `82.202.165.26`. The existing wildcard can provide these records. Do not change nameservers while propagation is pending.
2. Add new HTTPS domains to their existing Coolify applications, keeping the old domains first. Redeploy the same baseline images; verify old endpoints and both applications remain healthy.
3. Preserve storage CORS rules and add `https://app.reomi.ru` to the rule permitting the former web origin. Check OPTIONS for POST with `content-type` returns that allowed origin.
4. Prepare the web image changes on a branch. Do not merge the new API build URL and old-host redirect into main until the DNS/TLS gate passes.

## Cutover gate and execution

- Verify both authoritative nameservers and public recursive DNS return `82.202.165.26` for `app.reomi.ru` and `api.reomi.ru`.
- Verify HTTPS normally, without disabling certificate validation, on both hostnames. Certificate provisioning may need a same-image redeploy once DNS becomes available.
- Require the existing CI gates: strict OpenSpec validation, typecheck, migration-faithful `test:ci`, web/API build and real-S3 tests.
- Update API runtime `WEB_ORIGIN=https://app.reomi.ru` and `BETTER_AUTH_URL=https://api.reomi.ru`.
- Update web runtime `NEXT_PUBLIC_API_URL=https://api.reomi.ru`; the production workflow MUST also bake this value into the web image. Runtime alone cannot change browser JavaScript/CSP.
- Release through the existing main workflow, which deploys API before web. Verify both immutable tags match the released commit and both apps reach `running:healthy`.
- The old web hostname now returns 307 to the new origin, preserving paths and query strings. The canonical hostname and local development do not match that redirect.
- The old API hostname can be removed from Coolify and DNS by the operator. It is not a supported client endpoint. Do not redirect POST/SSE traffic or broaden CORS/cookies while it still answers. The old web hostname keeps its redirect.

## Acceptance

- New API `/health` and `/ready` respond; record degradation separately from availability.
- New web `/auth/sign-in` loads with valid TLS and CSP `connect-src` allowing the new API and existing S3 origin.
- Old web `/cards?focus=example` redirects exactly to `https://app.reomi.ru/cards?focus=example`.
- API session response and CORS allow credentials from the new web origin. Unauthenticated protected endpoints still reject access.
- S3 upload preflight succeeds for both new and old origins.
- Existing user signs in and sees their own data; test media upload if an authorized browser session is available. Record explicitly when a real authenticated browser check cannot be performed.

Accounts, stored cards, notebooks, media and personal tokens are unchanged. Cookies, local preferences, and unsaved local drafts belong to the old browser origin and are not copied. Users must sign in again; installed PWAs should be reinstalled from the new hostname. Save any local drafts before switching.

## Rollback

Point both Coolify apps at the recorded baseline immutable tag and deploy API then web. Verify `https://api.reomi.ru/ready` and sign-in on `https://app.reomi.ru`. Do not point `WEB_ORIGIN`, `BETTER_AUTH_URL`, or `NEXT_PUBLIC_API_URL` back at `https://api.neuronexus.mihailantonov.pro`. That host is not a supported endpoint and is not kept as a compatibility alias. The old web hostname may keep its redirect to `https://app.reomi.ru`. The additive S3 rule does not require rollback. Revert a repository build-URL change before the next main deploy only when it would send clients away from `https://api.reomi.ru`.

No database or storage rollback is necessary.

## Staging verification — 2026-09-21

- Both Coolify applications ran the baseline SHA and were `running:healthy`. The old web sign-in page returned 200. API readiness belongs to `https://api.reomi.ru`. `https://api.neuronexus.mihailantonov.pro` is not a supported endpoint.
- Production S3 OPTIONS for POST/content-type returns 200 and the matching allowed origin for both old and new web addresses.
- PR #20 code revision `60366b62bdf4be4273ecfd92c2f969276b392577` passed CI run `35582664461`, including migration-faithful tests, typecheck, builds, strict specs and real-S3 round trips.
- Initial staging waited for DNS propagation and certificates before changing active origins; the completed cutover is recorded below.
- The temporary `reomi-dns` heartbeat was deleted when the operator resumed the final cutover in this task.

## Completed cutover — 2026-09-21 09:38 UTC

- PR #20 merged as `6997fe310fc0654f07521fe6d3f361b4b1991e00`; gated deployment `35583851169` succeeded. Both Coolify apps run that immutable SHA and report `running:healthy`.
- Cloudflare and Google DNS resolve both domains to `82.202.165.26`. Both domains have valid Let's Encrypt certificates (expiry 2026-12-20), verified without certificate bypass.
- API production `WEB_ORIGIN`/`BETTER_AUTH_URL` and web runtime/build API URL now use the Reomi addresses.
- Live checks passed: web/CSP, HTTPS `sw.js` JavaScript, sign-in preflight 204 with exact origin and credentials, session response 200, protected profile 401, unrelated origin rejected by CORS, API readiness `ready` on `https://api.reomi.ru`, old-web 307 preserving path/query, and S3 upload preflight. The former API hostname is not a supported endpoint.
- A fresh browser opened the sign-in form with no console warnings/errors. Existing-account sign-in and an authenticated upload were not performed because no authenticated browser session was available. Users with an already open old build must reload, then sign in on the new origin.
