# DivSnap

DivSnap is a no-bundler Chrome Manifest V3 extension for selecting a DOM element and exporting its layout box as a PNG.

## Features

- Popup and `Alt+Shift+S` start the DOM Inspector on the active tab.
- Hover highlights an element and shows its `tag#id.class` selector plus CSS-pixel dimensions.
- Arrow keys navigate to the parent, first child, previous sibling, or next sibling.
- `Esc` tears down the inspector and removes its listeners and overlay.
- `Visible` captures the viewport-visible portion of the selected border box.
- `Full` scrolls the page and scrollable ancestors, stitches viewport tiles, and restores scroll positions. It captures the element's layout box, without expanding its internal overflow content.
- Canvas dimensions include `devicePixelRatio` for Retina and other high-density displays.
- PNG output can be copied with `ClipboardItem` and/or downloaded with a timestamped filename.

## Install locally

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked**.
3. Select the DivSnap directory.
4. Open the extension popup or press `Alt+Shift+S` on a normal web page.

After source changes, use **Reload** on the DivSnap extension card. The popup settings are stored in `chrome.storage.sync`:

```json
{
  "copyToClipboard": true,
  "downloadPng": true,
  "captureMode": "visible"
}
```

## Architecture

Open the [DivSnap MV3 architecture diagram](docs/architecture.html) for an interactive view of the extension boundary, capture flow, and output paths. The validated diagram specification is [docs/architecture.json](docs/architecture.json).

```text
Popup / Alt+Shift+S
        |
        v
background.js -- executeScript --> content.js -- DOM inspection --> active page
        |                               |
        | CAPTURE_VISIBLE              | Canvas crop / full stitch
        v                               v
captureVisibleTab -----------------> PNG Blob
                                        |\
                                        | +--> ClipboardItem PNG
                                        +----> DOWNLOAD_PNG -> downloads API
```

`background.js` is the MV3 service worker. It starts the on-demand injection, calls `captureVisibleTab`, and owns the download permission. `content.js` owns the Shadow DOM overlay, element inspection, scrolling, DPR-aware Canvas composition, Clipboard output, and HUD feedback. The PNG download payload crosses the runtime message boundary as base64 because extension message serialization can turn a raw `ArrayBuffer` into an empty object.

## Permissions and security

The manifest requests only `activeTab`, `scripting`, `storage`, `downloads`, and `clipboardWrite`. It does not request `<all_urls>` or persistent host permissions. Script injection occurs only after the user starts inspection on the active tab.

The overlay is an open Shadow DOM host with `pointer-events: none` and `z-index: 2147483647`. Page clicks are intercepted in the window capture phase while inspection is active, so selecting an element does not navigate the page. Cross-origin iframe documents are not entered; an iframe can only be selected as an element in the parent document.

Chrome restricted pages such as `chrome://`, the Chrome Web Store, and PDF viewers cannot be injected. The popup keeps open and reports the error when injection fails.

## Project layout

| Path | Responsibility |
| --- | --- |
| `manifest.json` | MV3 metadata, permissions, command, resources |
| `background.js` | Service worker, injection, capture, download bridge |
| `content.js` | Inspector, box model overlay, crop and stitch logic |
| `overlay.css` | Shadow DOM overlay styles |
| `popup/` | Settings UI and persistence |
| `icons/` | 16/32/48/128px extension icons |
| `docs/architecture.*` | Architecture diagram source and rendered artifact |

## Development checks

This is a vanilla extension and has no package manager or build step. Run the following checks from the project directory:

```bash
node --check background.js
node --check content.js
node --check popup/popup.js
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))'
```

The repository intentionally excludes local fixtures, generated captures, OS metadata, environment files, private keys, and agent state through `.gitignore`.

## License

No license has been selected yet.
