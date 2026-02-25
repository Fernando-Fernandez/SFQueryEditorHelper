# SF Query Editor Helper

A Chrome extension that intercepts Salesforce query responses and offers instant CSV download — no copy-paste, no row limits from the UI.

Works in two places:
- **Data Cloud Query Editor** (Lightning, `*.lightning.force.com`)
- **Developer Console Query Editor** (`/_ui/common/apex/debug/ApexCSIPage`), including the "Use Tooling API" checkbox

## Extension structure

```
SFQueryEditorHelper/
├── manifest.json        MV3 manifest
├── content-toast.js     MAIN world – shared Shadow DOM toast template (CSS + builder)
├── content.js           MAIN world – core engine (fetch/XHR patching, CSV generation)
└── popup.html           Extension popup (static info page)
```

## How it works

Both scripts are injected at `document_start` in the **MAIN world**, so they patch `window.fetch` and `XMLHttpRequest` before any Salesforce script runs.

### Data Cloud queries (Aura/Lightning)

1. Requests to the Aura endpoint (`/aura?r=…`) are intercepted. The form-encoded body is parsed to capture the SQL, action descriptor, and `aura.context` / `aura.token` for later pagination re-submission.
2. Responses are unwrapped from the Lightning envelope (`actions[0].returnValue`) and accumulated in a `Map` keyed by `status.queryId`. When `returnedRows >= rowCount` (or after a 5-second timeout for silently capped results) a Shadow DOM toast appears.
3. If the result was capped at 1 000 rows, a **Fetch all N rows** button re-submits the same Aura action with `LIMIT 49999 OFFSET N` in a loop until all rows are retrieved. No bearer token needed — the re-submission uses the same origin and session cookies.

### Developer Console SOQL queries

1. Requests to `/services/data/vXX/query/` are intercepted. Two guards prevent false positives:
   - The `columns=true` **metadata preflight** (first of the two Execute requests) is skipped — it contains column metadata, not records.
   - Tooling API background queries (`/tooling/query/`) are skipped unless they were preceded by a `columns=true` preflight (which only user-initiated "Use Tooling API" queries produce).
2. The second Execute response contains `{ totalSize, done, records }`. A toast appears immediately.
3. If `done` is `false`, a **Fetch all N rows** button chains through `nextRecordsUrl` GETs. Each continuation request replays the `Authorization: OAuth …` header captured from the original XHR.

### CSV download

Clicking **Download CSV** (or **Fetch all** after pagination) builds the file in-memory (`Blob` + UTF-8 BOM for Excel compatibility) and fires an invisible `<a download>` click. **No data ever leaves the page or passes through the extension's background layer.**

## Loading the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** → select this folder
4. Navigate to a Salesforce page, run a query, and the toast will appear bottom-right
