/**
 * content.js – runs in the MAIN world at document_start
 *
 * Responsibilities:
 *  1. Patch window.fetch and XMLHttpRequest BEFORE Salesforce scripts load.
 *  2. Detect DC query responses (dataRows + metadata).
 *  3. Accumulate partial results (initial batch + remaining rows) keyed by queryId.
 *  4. Once all rows are in, show an in-page toast with a "Download CSV" button.
 *  5. Post a lightweight message so the ISOLATED-world bridge can update the
 *     extension badge via the background service worker.
 *
 * NOTE: This script runs in the MAIN world and therefore has NO access to any
 *       chrome.* extension APIs. Communication with the extension happens via
 *       window.postMessage → content-bridge.js (ISOLATED world).
 */
(function () {
  'use strict';

  // Namespace prefix used to avoid collisions with page code
  const NS = '__SF_DC_CSV__';

  // ─────────────────────────────────────────────────────────────────────────────
  // Response detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Salesforce Aura / Lightning responses are enveloped:
   *   { actions: [ { returnValue: { dataRows, metadata, … } } ] }
   *
   * Only `dataRows` being an array is required — the "remaining rows" response
   * from getRemainingDCQueryResponseWithRetry omits `metadata`, so we must not
   * gate on it here.  Missing metadata is handled in processResponse by reusing
   * whatever the first (initial) response already stored in the accumulator.
   */
  function isDCQueryResponse(data) {
    const rv = data?.actions?.[0]?.returnValue;
    return rv != null && Array.isArray(rv.dataRows);
  }

  /** Unwrap the Aura envelope and return the inner returnValue object. */
  function unwrapPayload(data) {
    return data.actions[0].returnValue;
  }

  /**
   * Try to pull a queryId out of the request URL when the response body
   * doesn't embed one.  Handles patterns like:
   *   /services/data/v1/query/0Lf…
   *   /api/v1/query/results/0Lf…
   *   /query/0Lf…/results
   *   ?queryId=0Lf…
   */
  function extractQueryIdFromUrl(url) {
    if (typeof url !== 'string') return null;
    const patterns = [
      /\/query\/([A-Za-z0-9_-]{10,})(?:\/|$|\?)/i,
      /[?&]queryId=([A-Za-z0-9_-]+)/i,
    ];
    for (const re of patterns) {
      const m = url.match(re);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Extract the ANSI SQL string from a form-encoded Aura request body.
   *
   * Aura POSTs use Content-Type: application/x-www-form-urlencoded with a
   * "message" key whose value is a URL-encoded JSON object like:
   *   { "actions": [{ "params": { "method": "executeDCQuery",
   *                               "params": { "sql": "SELECT …" } } }] }
   *
   * Returns the SQL string, or null if not found / not parseable.
   */
  function extractSqlFromRequestBody(body) {
    if (typeof body !== 'string') return null;
    const m = body.match(/(?:^|&)message=([^&]*)/);
    if (!m) return null;
    try {
      const actions = JSON.parse(decodeURIComponent(m[1]))?.actions;
      for (const action of actions ?? []) {
        if (action?.params?.method === 'executeDCQuery') {
          const sql = action?.params?.params?.sql;
          if (typeof sql === 'string' && sql.trim()) return sql.trim();
        }
      }
    } catch (_) {}
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CSV generation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extract an ordered array of column names from whatever shape metadata is.
   *
   * Data Cloud API returns metadata as an array of objects.  Each object may
   * use different property names across API versions; we try the common ones.
   */
  function getColumnNames(metadata) {
    if (Array.isArray(metadata)) {
      return metadata.map(
        (col) =>
          col.name ??
          col.label ??
          col.displayName ??
          col.columnName ??
          col.fieldName ??
          String(col)
      );
    }
    if (metadata && Array.isArray(metadata.fields)) {
      return metadata.fields.map(
        (f) => f.name ?? f.label ?? f.fieldName ?? String(f)
      );
    }
    return [];
  }

  function escapeCell(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    // Wrap in quotes if the value contains a delimiter, quote, or line break
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function buildCSV(acc) {
    const columns = getColumnNames(acc.metadata);
    const lines = [];

    // Log the raw shapes so key-mapping issues are visible in DevTools → Console
    if (acc.dataRows.length > 0) {
      console.debug('[SF DC CSV Exporter] metadata[0]:', JSON.stringify(acc.metadata[0]));
      console.debug('[SF DC CSV Exporter] dataRows[0]: ', JSON.stringify(acc.dataRows[0]));
      console.debug('[SF DC CSV Exporter] resolved columns:', columns);
    }

    // Header row
    if (columns.length > 0) {
      lines.push(columns.map(escapeCell).join(','));
    }

    for (const entry of acc.dataRows) {
      // Each entry is { row: [val1, val2, …] } — unwrap the inner array
      const values = Array.isArray(entry?.row) ? entry.row : entry;
      lines.push(values.map(escapeCell).join(','));
    }

    return lines.join('\r\n');
  }

  /**
   * Build a CSV string from rows returned by the Data Cloud REST API.
   *
   * REST API format differs from the Aura format:
   *   - rows:     [{ FieldName: value, … }, …]   (plain objects)
   *   - metadata: { FieldName: { placeInOrder, type, typeCode }, … }  (keyed object)
   *
   * Columns are sorted by placeInOrder to preserve the original SELECT order.
   */
  function buildCSVFromRestRows(dataRows, metadata) {
    let columns;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      columns = Object.entries(metadata)
        .sort(([, a], [, b]) => (a.placeInOrder ?? 0) - (b.placeInOrder ?? 0))
        .map(([fieldName]) => fieldName);
    } else {
      columns = dataRows.length > 0 ? Object.keys(dataRows[0]) : [];
    }

    if (columns.length === 0) return '';

    if (dataRows.length > 0) {
      console.debug('[SF DC CSV Exporter] REST columns:', columns);
      console.debug('[SF DC CSV Exporter] REST dataRows[0]:', JSON.stringify(dataRows[0]));
    }

    const lines = [columns.map(escapeCell).join(',')];
    for (const row of dataRows) {
      lines.push(columns.map((col) => escapeCell(row[col])).join(','));
    }
    return lines.join('\r\n');
  }

  function triggerDownload(acc) {
    const csv = acc._isRestFormat
      ? buildCSVFromRestRows(acc.dataRows, acc.metadata)
      : buildCSV(acc);
    // Prepend UTF-8 BOM so Excel opens the file with correct encoding
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const shortId = acc.queryId ? String(acc.queryId).slice(-8) : 'query';
    a.download = `dc-query-${shortId}-${ts}.csv`;
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /**
   * Fetch all rows for a query directly via the Data Cloud REST API,
   * bypassing the UI's 1 000-row cap.
   *
   * Endpoint:  POST {origin}/api/v1/query?limit=49999&offset=N
   * Body:      { "sql": "…" }
   * Response:  { data: [{FieldName: val, …}, …], rowCount: N, done: bool,
   *              metadata: { FieldName: { placeInOrder, type, typeCode } } }
   *
   * Uses _origFetch to avoid recursively triggering our own patch.
   * Session cookies are sent automatically (same-origin request).
   */
  async function fetchAllRows(acc, { onProgress, onDone, onError }) {
    const BATCH = 49_999;
    const url = `${acc.apiOrigin}/api/v1/query`;
    const body = JSON.stringify({ sql: acc.sqlQuery });

    let allRows = [];
    let restMetadata = null;
    let offset = 0;
    let totalRows = acc.totalRows === Infinity ? null : acc.totalRows;

    try {
      while (true) {
        let resp;
        try {
          resp = await _origFetch(`${url}?limit=${BATCH}&offset=${offset}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body,
          });
        } catch (networkErr) {
          onError('Network error: ' + networkErr.message);
          return;
        }

        if (resp.status === 401 || resp.status === 403) {
          onError(`Authentication error (${resp.status}). Try refreshing the page.`);
          return;
        }
        if (!resp.ok) {
          let detail = '';
          try { detail = await resp.text(); } catch (_) {}
          onError(`Server error ${resp.status}${detail ? ': ' + detail.slice(0, 120) : ''}`);
          return;
        }

        let page;
        try {
          page = await resp.json();
        } catch (_) {
          onError('Failed to parse API response as JSON');
          return;
        }

        if (!restMetadata && page.metadata) restMetadata = page.metadata;
        if (typeof page.rowCount === 'number') totalRows = page.rowCount;

        const pageRows = Array.isArray(page.data) ? page.data : [];
        allRows = allRows.concat(pageRows);
        offset += pageRows.length;

        onProgress(allRows.length, totalRows ?? allRows.length);

        if (
          page.done === true ||
          pageRows.length < BATCH ||
          (totalRows !== null && allRows.length >= totalRows) ||
          pageRows.length === 0
        ) {
          break;
        }
      }
    } catch (e) {
      onError('Unexpected error: ' + e.message);
      return;
    }

    onDone(allRows, restMetadata);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // In-page toast notification (Shadow DOM for CSS isolation)
  // ─────────────────────────────────────────────────────────────────────────────

  let currentToastHost = null;

  function showToast(acc) {
    // Replace any existing toast
    if (currentToastHost) {
      currentToastHost.remove();
      currentToastHost = null;
    }

    const isLimited = acc.returnedRows < acc.totalRows && acc.totalRows !== Infinity;
    const canFetchAll = isLimited && typeof acc.sqlQuery === 'string';

    const host = document.createElement('div');
    host.setAttribute('data-sf-dc-csv-exporter', '');
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const columns = getColumnNames(acc.metadata);

    const actionsHtml = isLimited
      ? `
        <div class="warning-banner">
          Showing ${acc.returnedRows.toLocaleString()} of ${acc.totalRows.toLocaleString()} rows &mdash; query limit hit
        </div>
        <div class="actions">
          ${canFetchAll ? `<button class="btn btn-fetch-all" id="fetchAll">Fetch all ${acc.totalRows.toLocaleString()} rows</button>` : ''}
          <button class="btn btn-download-limited" id="download">Download ${acc.returnedRows.toLocaleString()} rows</button>
          <button class="btn btn-dismiss" id="dismiss">Dismiss</button>
        </div>
        <div class="progress-wrap" id="progressWrap" style="display:none">
          <div class="progress-bar-track"><div class="progress-bar-fill" id="progressFill"></div></div>
          <div class="progress-text" id="progressText"></div>
        </div>`
      : `
        <div class="actions">
          <button class="btn btn-download" id="download">Download CSV</button>
          <button class="btn btn-dismiss" id="dismiss">Dismiss</button>
        </div>`;

    shadow.innerHTML = `
      <style>
        :host { all: initial; }

        .toast {
          position: fixed;
          bottom: 24px;
          right: 24px;
          background: #ffffff;
          border: 1px solid #dddbda;
          border-left: 4px solid #0176d3;
          border-radius: 6px;
          box-shadow: 0 6px 28px rgba(0, 0, 0, 0.18);
          padding: 16px 18px 14px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Salesforce Sans',
                       'Segoe UI', Helvetica, Arial, sans-serif;
          min-width: 285px;
          max-width: 420px;
          animation: slide-in 0.3s cubic-bezier(0.4, 0, 0.2, 1) both;
        }

        @keyframes slide-in {
          from { opacity: 0; transform: translateX(110%); }
          to   { opacity: 1; transform: translateX(0); }
        }

        .toast.closing {
          animation: slide-out 0.25s cubic-bezier(0.4, 0, 0.2, 1) both;
        }

        @keyframes slide-out {
          to { opacity: 0; transform: translateX(110%); }
        }

        .header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 4px;
        }

        .title {
          font-size: 14px;
          font-weight: 600;
          color: #032d60;
          line-height: 1.3;
        }

        .close-btn {
          background: none;
          border: none;
          cursor: pointer;
          color: #706e6b;
          font-size: 20px;
          line-height: 1;
          padding: 0 2px;
          flex-shrink: 0;
          margin-top: -2px;
        }
        .close-btn:hover { color: #032d60; }
        .close-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .meta {
          font-size: 12px;
          color: #706e6b;
          margin-bottom: 10px;
        }

        .warning-banner {
          font-size: 11px;
          color: #a8660a;
          background: #fef3cd;
          border: 1px solid #f5c518;
          border-radius: 4px;
          padding: 5px 8px;
          margin-bottom: 10px;
        }

        .actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .btn {
          padding: 6px 14px;
          border-radius: 4px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid transparent;
          transition: background 0.15s;
        }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; }

        .btn-download {
          background: #0176d3;
          color: #fff;
          border-color: #0176d3;
        }
        .btn-download:hover:not(:disabled) { background: #014486; border-color: #014486; }

        .btn-download-limited {
          background: #fff;
          color: #0176d3;
          border-color: #0176d3;
        }
        .btn-download-limited:hover:not(:disabled) { background: #f0f7ff; }

        .btn-fetch-all {
          background: #2e844a;
          color: #fff;
          border-color: #2e844a;
        }
        .btn-fetch-all:hover:not(:disabled) { background: #1d5e35; border-color: #1d5e35; }

        .btn-dismiss {
          background: #f3f2f2;
          color: #3e3e3c;
          border-color: #dddbda;
        }
        .btn-dismiss:hover:not(:disabled) { background: #e5e5e5; }

        .progress-wrap { margin-top: 10px; }

        .progress-bar-track {
          height: 6px;
          background: #e5e5e5;
          border-radius: 3px;
          overflow: hidden;
        }

        .progress-bar-fill {
          height: 100%;
          background: #2e844a;
          border-radius: 3px;
          width: 0%;
          transition: width 0.3s ease;
        }

        .progress-text {
          font-size: 11px;
          color: #706e6b;
          margin-top: 4px;
        }
        .progress-text.error { color: #c23934; }
      </style>

      <div class="toast" id="toast">
        <div class="header">
          <span class="title">&#x1F4CA; DC Query Result Ready</span>
          <button class="close-btn" id="close" title="Dismiss">&times;</button>
        </div>
        <div class="meta">
          ${acc.returnedRows.toLocaleString()} row${acc.returnedRows !== 1 ? 's' : ''}
          &bull;
          ${columns.length} column${columns.length !== 1 ? 's' : ''}
          ${acc.queryId ? `&bull; <code style="font-size:11px">${acc.queryId.slice(-12)}</code>` : ''}
        </div>
        ${actionsHtml}
      </div>
    `;

    currentToastHost = host;

    const animateClose = (then) => {
      const toastEl = shadow.getElementById('toast');
      toastEl.classList.add('closing');
      toastEl.addEventListener('animationend', () => {
        host.remove();
        if (currentToastHost === host) currentToastHost = null;
        if (then) then();
      }, { once: true });
    };

    shadow.getElementById('close').addEventListener('click', () => animateClose());
    shadow.getElementById('dismiss').addEventListener('click', () => animateClose());
    shadow.getElementById('download').addEventListener('click', () => {
      animateClose(() => triggerDownload(acc));
    });

    const fetchAllBtn = shadow.getElementById('fetchAll');
    if (fetchAllBtn) {
      fetchAllBtn.addEventListener('click', () => {
        // Lock UI while fetching
        fetchAllBtn.disabled = true;
        shadow.getElementById('download').disabled = true;
        shadow.getElementById('dismiss').disabled = true;
        shadow.getElementById('close').disabled = true;
        shadow.getElementById('progressWrap').style.display = 'block';

        fetchAllRows(acc, {
          onProgress(fetched, total) {
            const pct = total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : 0;
            shadow.getElementById('progressFill').style.width = pct + '%';
            shadow.getElementById('progressText').textContent =
              `Fetching… ${fetched.toLocaleString()} / ${total.toLocaleString()} rows (${pct}%)`;
          },
          onDone(allRows, restMetadata) {
            const fullAcc = {
              queryId: acc.queryId,
              dataRows: allRows,
              metadata: restMetadata,
              returnedRows: allRows.length,
              totalRows: allRows.length,
              _isRestFormat: true,
            };
            animateClose(() => triggerDownload(fullAcc));
          },
          onError(message) {
            shadow.getElementById('progressFill').style.width = '0%';
            const pt = shadow.getElementById('progressText');
            pt.textContent = message;
            pt.classList.add('error');
            // Re-enable fallback controls
            shadow.getElementById('download').disabled = false;
            shadow.getElementById('dismiss').disabled = false;
            shadow.getElementById('close').disabled = false;
            fetchAllBtn.textContent = 'Retry';
            fetchAllBtn.disabled = false;
          },
        });
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Query accumulator
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // executeDCQuery() calls:
  //   1. getInitialDCQueryResponse  → response A  (has metadata, queryId, rowCount)
  //   2. getRemainingDCQueryResponseWithRetry → response B  (more dataRows, same queryId)
  //
  // We accumulate by queryId.  When returnedRows >= rowCount we know we're done.

  const store = new Map(); // queryId → accumulated entry

  function processResponse(data, requestUrl, capturedSql = null) {
    if (!isDCQueryResponse(data)) return;

    // All real fields live inside the Aura returnValue envelope
    const payload = unwrapPayload(data);

    // Prefer queryId from response body; fall back to URL
    const queryId =
      payload.status?.queryId ?? extractQueryIdFromUrl(requestUrl) ?? null;

    const thisPageRows =
      typeof payload.returnedRows === 'number' ? payload.returnedRows : payload.dataRows.length;

    const totalRows =
      typeof payload.status?.rowCount === 'number' ? payload.status.rowCount : null;

    if (queryId) {
      // ── Accumulating query ───────────────────────────────────────────────
      if (!store.has(queryId)) {
        store.set(queryId, {
          queryId,
          dataRows: [],
          metadata: payload.metadata,
          returnedRows: 0,
          totalRows: totalRows ?? Infinity,
          _flushTimer: null,
          sqlQuery: capturedSql ?? null,
          apiOrigin: window.location.origin,
        });
      }

      const acc = store.get(queryId);
      acc.dataRows.push(...payload.dataRows);
      acc.returnedRows += thisPageRows;

      // Refresh totalRows if a better value arrives (e.g., in the 2nd response)
      if (totalRows !== null) acc.totalRows = totalRows;

      // Keep the metadata from the first response that has it
      if (!acc.metadata && payload.metadata) acc.metadata = payload.metadata;

      // SQL may arrive on the initial response but not on the remaining-rows
      // response — update it whenever we get a non-null value
      if (capturedSql && !acc.sqlQuery) acc.sqlQuery = capturedSql;

      if (acc.returnedRows >= acc.totalRows) {
        // All rows received — flush immediately
        if (acc._flushTimer) clearTimeout(acc._flushTimer);
        store.delete(queryId);
        showToast(acc);
        postBadgeMessage(acc.returnedRows, getColumnNames(acc.metadata).length);
      } else if (acc.returnedRows > 0) {
        // We have rows but haven't hit totalRows yet.  The server may have
        // silently capped the result (e.g. the automatic 1 000-row limit), so
        // no further response will arrive.  Arm a 5-second timeout: if nothing
        // else comes in for this queryId we flush whatever we have.
        // Normal multi-page queries return their remaining rows within
        // milliseconds, so the timer will be cancelled long before it fires.
        if (acc._flushTimer) clearTimeout(acc._flushTimer);
        acc._flushTimer = setTimeout(() => {
          if (!store.has(queryId)) return; // already flushed
          store.delete(queryId);
          showToast(acc);
          postBadgeMessage(acc.returnedRows, getColumnNames(acc.metadata).length);
        }, 5_000);
      }
    } else {
      // ── No queryId – treat as self-contained single-page result ──────────
      // Without metadata we can't produce column headers, so skip.
      if (!payload.metadata) return;

      const acc = {
        queryId: null,
        dataRows: payload.dataRows,
        metadata: payload.metadata,
        returnedRows: thisPageRows,
        totalRows: thisPageRows,
      };
      showToast(acc);
      postBadgeMessage(acc.returnedRows, getColumnNames(acc.metadata).length);
    }
  }

  /** Notify the ISOLATED world bridge so it can update the extension badge. */
  function postBadgeMessage(rowCount, colCount) {
    window.postMessage(
      { type: `${NS}:QUERY_READY`, rowCount, colCount },
      '*'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Patch window.fetch
  // ─────────────────────────────────────────────────────────────────────────────

  const _origFetch = window.fetch;

  window.fetch = async function (...args) {
    // Capture the request URL and body before the call
    const requestUrl =
      typeof args[0] === 'string'
        ? args[0]
        : args[0] instanceof Request
        ? args[0].url
        : '';

    // args[1] is the fetch init object; body is a plain string for Aura POSTs
    const capturedSql = extractSqlFromRequestBody(args[1]?.body ?? null);

    const response = await _origFetch.apply(this, args);

    // Clone so we don't consume the body the page expects
    try {
      response
        .clone()
        .json()
        .then((data) => processResponse(data, requestUrl, capturedSql))
        .catch(() => {}); // ignore non-JSON or parse errors
    } catch (_) {}

    return response;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Patch XMLHttpRequest
  // ─────────────────────────────────────────────────────────────────────────────

  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    // Store the request URL so we can read it in the load handler
    this[NS + '_url'] = typeof args[1] === 'string' ? args[1] : '';
    return _origOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    // args[0] is the request body — a plain string for form-encoded Aura POSTs
    this[NS + '_sql'] = extractSqlFromRequestBody(args[0] ?? null);

    this.addEventListener('load', () => {
      if (this.status < 200 || this.status >= 300) return;
      const ct = this.getResponseHeader('content-type') || '';
      if (!ct.includes('json')) return;
      try {
        processResponse(JSON.parse(this.responseText), this[NS + '_url'], this[NS + '_sql']);
      } catch (_) {}
    });
    return _origSend.apply(this, args);
  };

  // ─────────────────────────────────────────────────────────────────────────────

  console.debug('[SF DC CSV Exporter] Initialized – monitoring DC query responses');
})();
