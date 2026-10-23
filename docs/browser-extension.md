# Reomi browser capture

The browser extension saves the current article or selected passage to the ordinary Reomi library. **Save + create a card** first saves that material, then opens Reomi's existing card editor. Choose a deck, review/edit the question and answer, and explicitly save. Optional AI suggestion uses the web account's existing settings and limits; saving a material and manually writing a card require no AI call.

## Install and connect

Build from the repository root with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run --filter @reomi/extension build
```

The deterministic archives are `apps/extension/dist/reomi-chromium-0.1.0.zip` and `reomi-firefox-0.1.0.zip`. Each contains the manifest at its root. Release builds connect only to `api.reomi.ru` and open `app.reomi.ru`.

- Chrome/Edge: extract the Chromium zip, open the browser's Extensions page, enable Developer mode, choose **Load unpacked**, and select the extracted directory. Managed browsers can forbid this; do not change administrator policy to install it.
- Firefox 142+: extract the Firefox zip, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json`. Temporary installation ends when Firefox closes. Permanent standard Firefox installation needs Mozilla signing; no store listing or signed XPI is claimed by this release.
- In Reomi **Settings → Connections**, create a token with **Browser capture** permissions. Paste it into the extension's Connection screen. The web app uses its own normal sign-in when opening the card editor. Use the same account. Revoke the token in Reomi to stop further extension access; Disconnect clears this browser's token and pending capture.

Open a normal HTTP(S) article, click Reomi, inspect its title, original address and text, select Page or Selection, and choose a folder. The default **From browser** folder is created lazily on the first successful save. You can choose an existing nested folder or Unfiled. The selection context menu and **Alt+Shift+S** open the same preview. Browser-reserved or site shortcuts may conflict; change the shortcut in the browser's extension settings. Restricted browser/store pages cannot be captured.

The first version supports 200,000 characters per page and 4,000 per selection, never silent truncation. For whole-page card creation the editor labels the opening passage it offers; read/select another passage in the source when needed. One reviewed card is created per action. Bulk generation is outside this release.

## Privacy and failures

Only an explicit Save uploads the previewed text, title, original URL, mode and chosen folder to Reomi. Preview and extraction run locally. The extension has activeTab, scripting, storage, contextMenus and the Reomi API host permission. It has no browsing-history, cookies, all-sites or background content-script permission. It does not send HTML, form values, passwords, editable fields or hidden text. A visible article may still contain personal content; inspect the preview before saving it. The server stores the submitted snapshot and does not refetch the page. Some applications provide no readable article; selecting a visible passage is the fallback.

The credential stays in local extension storage, never browser sync, the captured page, URL or logs. Chrome limits that storage to trusted extension contexts where supported. An uncertain save keeps its owner-bound pending payload and request key locally for 30 minutes so closing/reopening and retrying recover the same receipt. It is cleared on success, disconnect, expiry at the next open, or an account change. Local extension storage is not a separate encrypted vault.

Identical captures reuse a still-unchanged captured source without changing its folder or title. Changed content creates a new snapshot, preserving earlier study work. Retrying a deleted receipt reports deletion; an explicit new capture may save it again. Invalid/expired/revoked credentials show reconnect; missing folders, limits and failures remain visible. Nothing automatically creates a card. The handoff verifies ownership and source text; stale text after opening the editor is rejected by the existing card evidence checks.

## Development and verification

`bun run --filter @reomi/extension build:dev` targets localhost ports 3000/3001. Only the dev build accepts `REOMI_EXTENSION_TEST_ORIGIN` to grant a single local fixture origin for automated content-script tests in place of clicking the browser toolbar. Never distribute a dev archive as production.

`e2e/browser-extension.e2e.ts` loads the real extension in a fresh Chromium profile, previews a selected passage, excludes form content, simulates a committed save whose response is lost, reopens/retries, creates a reviewed card with source evidence, and checks token revocation. The profile and fixture data are removed. CI must run it. `E2E_SKIP_UNPACKED_EXTENSION=true` is only for environments whose administrator policy forbids unpacked extensions; that skip is not acceptance evidence. `e2e/browser-capture-handoff.e2e.ts` independently verifies the API-to-web flow, 320px standalone display-mode emulation and keyboard submission.

Extraction and migrated API tests cover privacy exclusions, bounds, ownership, narrow token scope, destination/quota atomicity, concurrent retries, changed/deleted material and stale card evidence. Firefox `web-ext lint` has zero manifest errors; two warnings originate in bundled Readability's DOM cloning. Readability operates on a detached sanitized clone, and its output reaches the popup via textContent, never executable HTML. These warnings do not constitute a Firefox runtime test. Actual Firefox installation, signed distribution, physical mobile Safari and VoiceOver remain separate checks.

Deploy additive migration/API 0052 before web. Rollback leaves receipt rows and normal source text in place; older web builds simply have no capture-token selector or handoff editor. Revoke capture tokens when retiring an installation. Keep trace/video/snapshots off during credential entry and run the existing secret-artifact scanner before attaching evidence.
