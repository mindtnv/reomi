Save a readable page or selection to your Reomi library, then optionally create a reviewed card with its source. Connect using a revocable **Browser capture** token from Reomi Settings → Connections.

Chromium: extract the zip and use Extensions → Developer mode → Load unpacked. Firefox 142+: use `about:debugging` → This Firefox → Load Temporary Add-on → select `manifest.json`. The Firefox zip is unsigned and temporary; a permanent signed installation/store listing is not included.

Release packages request only activeTab, scripting, storage, contextMenus and the official Reomi API host. They capture only after your action and upload only after Save. No browsing history or cookies permission. Page limit: 200,000 characters; selection limit: 4,000. AI suggestion is optional and follows the account's existing limits; cards always require review and Save.

See [installation, privacy and limitations](https://github.com/mindtnv/reomi/blob/main/docs/browser-extension.md). Compare the downloaded archives with the attached SHA256SUMS. Managed-browser policies may prohibit unpacked extensions; do not override those policies.
