# DivSnap

DivSnap is a no-bundler Chromium Manifest V3 extension for Microsoft Edge and Google Chrome, for selecting DOM elements and exporting their layout bounds from one movable in-page panel. Edge is the primary target; both browsers use the shared `chrome.*` extension APIs.

## Features

- Version 1.4.0: `Ctrl`/`Cmd` + `Z` undoes up to 10 selection steps, including a locked preview. Press `d` twice quickly to clear a confirmed selection or locked preview. These shortcuts work while the in-page panel is focused. Profile and output settings start collapsed and remember their expanded state. The panel stays fully usable while selecting; click its title to collapse it, then drag the compact bar to move it or use its Expand button to restore it. Close with the top-right ×, two Esc presses within 500 ms, or a second click on the extension icon.

- The extension icon opens or reuses one draggable, resizable Shadow DOM panel in the current web page and binds it to that tab. Clicking the icon from another web tab removes the old panel and stops the old Inspector. The browser command opens the panel and starts inspection. No shortcut is assigned by default.
- Hover highlights an element and shows its `tag#id.class` selector plus CSS-pixel dimensions.
- Hover only previews. Click locks the current preview; `Shift` + click adds or removes elements. `Enter` locks the preview when needed, `Esc` unlocks it, and a second `Enter` saves the image. `Space` also unlocks the preview.
- Up/down arrows navigate outward/inward along the hit element's ancestor chain, skipping consecutive bounds whose edges differ by at most 1 CSS pixel. Left/right arrows navigate visible siblings. Navigation locks the preview and remains available during multi-selection.
- The in-page panel's candidate list exposes all valid ancestor levels, including same-size wrappers and overlapping elements underneath the pointer. HTML elements, canvas, SVG, and open Shadow DOM are supported; selection is not limited to divs or small containers.
- `Shift` + click (or the panel's add/remove button) toggles the displayed candidate, then unlocks the preview. Explicitly selecting a parent replaces its selected descendants; selecting a child replaces its selected ancestor. Page clicks do not capture.
- `Ctrl`/`Cmd` + `Z` or the undo button restores the previous selection, including a whole parent/child replacement or clear operation. With no history, it unlocks the current preview. Up to 10 changes are retained per session. Press `d` twice quickly to clear a confirmed selection or locked preview. The selected list supports individual removal.
- The panel captures the confirmed selection's union bounds. With no confirmed selection, a locked single preview is required. Cyan marks the preview, green double borders mark confirmed elements, and a yellow dashed border marks the output rectangle, including all intervening visible content. The panel remains opaque while selection is active.
- Scroll, resize, and DOM updates refresh the overlays. Disconnected or hidden selected elements remain listed as invalid and block capture until removed or reselected.
- `Esc` tears down the inspector and removes its listeners and overlay. Closing the panel also stops the Inspector and restores scroll positions if a capture is in progress. During capture, all DivSnap UI is hidden without unloading the iframe, then restored paused with the selection intact.
- `Visible` captures the viewport-visible portion of the selected border box.
- `Full` scrolls the page and compatible scrollable ancestors, stitches viewport tiles, and restores scroll positions. It captures the selected element or multi-selection's layout box, without expanding internal overflow content.
- If a multi-selection spans different scroll containers or exceeds the canvas limit, `Full` falls back to `Visible` with a warning.
- Canvas dimensions include `devicePixelRatio` for Retina and other high-density displays.
- PNG output can be copied with `ClipboardItem`; saved images support PNG and high-quality WebP (`0.95`). The default is the browser Downloads folder. A selected folder is stored as a File System Access directory handle in extension-origin IndexedDB; the service worker writes there without using the Edge download list or overwriting an existing filename.
- Choosing or reauthorizing a folder opens an extension settings tab; the native picker runs only after an explicit button click. Cancel keeps the existing handle, and a successful update returns to the bound page and refreshes the panel.
- Named local Profiles are stored in `chrome.storage.local`. They save only page identity and element location descriptors, so the same dashboard Profile can be loaded after changing time ranges or filters. Stable dashboard panels use `data-test-embeddable-id`; ambiguous, missing, or path-only matches require confirmation, repair, or explicit dismissal before capture.

## Install locally

1. In Microsoft Edge, open `edge://extensions` and enable **Developer mode**. In Chrome, use `chrome://extensions`.
2. Choose **Load unpacked**.
3. Select the DivSnap directory.
4. Click the DivSnap extension icon on a normal web page, or press the configured shortcut.

After source changes, use **Reload** on the DivSnap extension card. The panel output settings are stored in `chrome.storage.sync`:

```json
{
  "copyToClipboard": true,
  "downloadEnabled": true,
  "captureMode": "visible",
  "imageFormat": "png"
}
```

The Inspector shortcut is managed by the browser rather than `chrome.storage.sync`. It is unassigned by default. Use the panel's **快捷鍵設定** button or open `edge://extensions/shortcuts` in Edge (`chrome://extensions/shortcuts` in Chrome) to assign or clear it; the panel displays `啟動選取：未設定` or the current assignment after returning.

Profiles are page-scoped and are not synchronized between devices. Directory handles and Profiles are not sent through runtime messages. If a saved folder loses permission, DivSnap reports the failure and exposes **重新授權** instead of silently falling back to Downloads. Clipboard output always uses PNG, including when saved output is WebP.

## Architecture

Open the [DivSnap MV3 architecture diagram](docs/architecture.html) for an interactive view of the extension boundary, capture flow, and output paths. The validated diagram specification is [docs/architecture.json](docs/architecture.json).

```text
Action icon / Configured browser command
        |
        v
background.js -- tab/session + Port --> in-page Shadow DOM panel
        |                                  |
        | executeScript + INSPECT_COMMAND  | INSPECT_STATE / CAPTURE_RESULT
        v                                  v
content.js -- DOM inspection + panel --> active page
        |
        +--> CAPTURE_VISIBLE -> background -> PNG tiles
                                      |
                                      v
                              panel iframe output
                              |\       |\
                              |        +--> File System Access folder
                              +--> PNG ClipboardItem
                              +--> DOWNLOAD_IMAGE -> browser Downloads
```

`background.js` is the MV3 service worker. It owns tab/document/session binding, the control Port, on-demand injection, `captureVisibleTab`, browser Downloads, extension-origin directory handles, directory writes, and the extension settings tab. `content.js` owns the box overlay, the draggable/collapsible Shadow DOM panel and iframe host, DOM inspection, scrolling, DPR-aware Canvas composition, and serialized state/capture messages. `popup/popup.js` owns settings, directory metadata, Profiles, output encoding, clipboard retry, and recent-result retry. Binary image data crosses the runtime boundary as base64; directory handles never do.

## Permissions and security

The manifest requests only `activeTab`, `scripting`, `storage`, `downloads`, and `clipboardWrite`. It does not request `<all_urls>` or persistent host permissions. Script injection occurs only after the user starts inspection on the active tab.

The overlay and control panel are separate Shadow DOM hosts at `z-index: 2147483647`. The overlay has `pointer-events: none`; the panel and its iframe have normal pointer events and are excluded from candidates and page interception. Page pointer presses, clicks, and drag/selection events are intercepted in the window capture phase while inspection is active. Iframe documents and closed Shadow DOM are not entered; an iframe can only be selected as an element in the parent document.

Selection determines a screenshot rectangle, not isolated DOM rendering: intervening content and page overlays remain in the PNG. Canvas regions without their own DOM nodes require a future free-crop mode. Full capture uses bounding-rectangle stitching for SVG and retains the existing scroll-container and canvas-size fallback rules. The overlay is hidden during capture, then restored in a paused state with the selected DOM references intact.

Browser-restricted pages such as `edge://`, `chrome://`, extension stores, and built-in PDF viewers cannot be injected. The panel is not created and the extension reports the error when injection fails.

## Project layout

| Path | Responsibility |
| --- | --- |
| `manifest.json` | MV3 metadata, permissions, command, resources |
| `background.js` | Service worker, tab/session routing, control Port, capture and download bridge |
| `content.js` | Inspector, Shadow DOM panel and overlay, profile resolution, crop and stitch logic |
| `overlay.css` | Shadow DOM overlay styles |
| `popup/` | Embedded panel UI, settings, Profiles, folder output and retry actions |
| `settings/` | Explicit-button folder picker and File System Access reauthorization |
| `icons/` | 16/32/48/128px extension icons |
| `docs/architecture.*` | Architecture diagram source and rendered artifact |

## Development checks

This is a vanilla extension and has no package manager or build step. Run the following checks from the project directory:

```bash
node --check background.js
node --check content.js
node --check popup/popup.js
node --check settings/directory.js
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))'
```

The repository intentionally excludes local fixtures, generated captures, OS metadata, environment files, private keys, and agent state through `.gitignore`.

## License

No license has been selected yet.
