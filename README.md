# SF Data Cloud Query CSV Exporter

A Chrome extension that intercepts Salesforce Data Cloud query responses and offers instant CSV download — no copy-paste, no row limits from the UI.

## Extension structure

```
SFQueryEditorHelper/
├── manifest.json        MV3 manifest
├── content.js           MAIN world – the core engine
├── content-bridge.js    ISOLATED world – messaging bridge
├── background.js        Service worker – badge counter
├── popup.html           Extension popup UI
└── popup.js             Popup logic
```

## How it works

**Data flow:**

1. `content.js` is injected at `document_start` in the **MAIN world**, so it patches `window.fetch` and `XMLHttpRequest` before any Salesforce script runs.
2. Every response body is checked for `dataRows` + `metadata`. Matching responses are accumulated in a `Map` keyed by `status.queryId` (with a URL fallback for cases where the response body omits the ID).
3. When `returnedRows >= rowCount` the accumulation is complete — mirroring exactly what `executeDCQuery` does when it merges the initial and remaining-rows responses. A Shadow DOM toast appears bottom-right.
4. Clicking **Download CSV** builds the file in-memory (`Blob` + UTF-8 BOM for Excel), fires an invisible `<a download>` click, and removes the toast. **No data ever leaves the page.**
5. `content-bridge.js` listens to the `window.postMessage` the MAIN script emits and forwards a lightweight signal (row/col counts only — no payload) to the background.
6. `background.js` increments a per-tab counter in `chrome.storage.session` and updates the toolbar badge.

## Loading the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** → select this folder
4. Navigate to any `*.salesforce.com` page, run a DC query, and the toast will appear

## One thing to verify

Open DevTools → Network on your DC Query Editor page, run a query, and confirm the actual endpoint URLs. If the "remaining rows" response embeds `status.queryId` in its body (most likely yes), accumulation will merge both halves automatically. If it doesn't, the extension will still show two separate toasts (one per response), both downloadable. Adjust `extractQueryIdFromUrl` in `content.js` with the real URL pattern if needed.
