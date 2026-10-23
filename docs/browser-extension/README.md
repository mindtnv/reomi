# Browser capture evidence

The local API-to-web journey passed in Chromium on 2026-10-21: save a selected passage, open the owned card handoff, reload at 320px, submit with Ctrl+Enter and verify the persisted source backlink and quote. The screenshots below were visually reviewed. Standalone is display-mode emulation, not a physical PWA installation.

| Screen | Normal browser | Standalone, 320px |
| --- | --- | --- |
| Reviewed card and source | [Light desktop](handoff-desktop-light.png) | [Dark small screen](handoff-standalone-small-dark.png) |
| Scoped app access | [Light desktop](settings-desktop-light.png) | [Dark small screen](settings-standalone-small-dark.png) |

An initial mobile reload exposed duplicate modal history for the URL-backed handoff. The capture dialog now uses its route's history and removes the capture query as a view-only update after close/save. The successful journey covers that regression. No token value is shown in these images.

Actual unpacked-extension evidence is produced by `e2e/browser-extension.e2e.ts` in CI and uploaded as `browser-capture-evidence`. The managed local Chromium administrator policy forbids loading unpacked extensions; a skipped local extension test is not counted as a pass. Firefox manifest lint and reproducible zip tests do not establish Firefox runtime or store-signing acceptance.

The [English light](popup-preview-fixture-en.png) and [Russian dark](popup-preview-fixture-ru.png) popup images render the shipped HTML/CSS with an explicitly labelled content fixture for local visual review. They are not extension-installation evidence. The actual loaded-extension run [39665987698](https://github.com/mindtnv/reomi/actions/runs/39665987698) passed its extension case in 11.3 seconds and uploaded artifact `browser-capture-evidence` (ID 12377009019); browser total 9 passed, 2 expected skips.
