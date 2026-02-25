/**
 * content.js – runs in the MAIN world at document_start
 *
 * Responsibilities:
 *  1. Patch window.fetch and XMLHttpRequest BEFORE Salesforce scripts load.
 *  2. Detect DC query responses (Aura envelope) and SOQL query responses
 *     (Developer Console / Tooling API).
 *  3. Accumulate DC partial results keyed by queryId; show a Shadow DOM toast
 *     once complete (or after a 1.5-second timeout for silently capped results).
 *  4. Show a Shadow DOM toast for SOQL results, filtering out background
 *     Tooling API queries via the columns=true preflight arm/consume pattern.
 *  5. Offer in-place "Fetch all rows" pagination:
 *     – DC queries re-submit the original Aura action with LIMIT/OFFSET.
 *     – SOQL queries chain through nextRecordsUrl GETs.
 *
 * NOTE: This script runs in the MAIN world and therefore has NO access to
 *       chrome.* extension APIs.
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

  /**
   * Salesforce REST SOQL responses (Developer Console, Tooling API, etc.):
   *   { totalSize: N, done: bool, records: [ { attributes: {type,url}, …fields } ] }
   *
   * Require the distinguishing trio of fields to avoid false positives.
   */
  function isSoqlQueryResponse(data) {
    return (
      Array.isArray(data?.records) &&
      typeof data?.totalSize === 'number' &&
      typeof data?.done === 'boolean'
    );
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
   * Extract Aura context needed to re-submit paginated queries.
   *
   * Aura POSTs are form-encoded:
   *   message=<URL-encoded JSON>&aura.context=<...>&aura.token=<...>
   *
   * The message JSON contains the action descriptor, params (sql, rowLimit,
   * dataspace), etc.  We keep aura.context and aura.token as raw URL-encoded
   * strings so we can forward them verbatim in re-submissions.
   *
   * Returns { sql, descriptor, dataspace, auraContext, auraToken, auraUrl }
   * or null if the body is not a DC query Aura request.
   */
  function extractAuraInfo(body, requestUrl) {
    if (typeof body !== 'string') return null;
    const msgMatch = body.match(/(?:^|&)message=([^&]*)/);
    if (!msgMatch) return null;
    const ctxMatch = body.match(/(?:^|&)aura\.context=([^&]*)/);
    const tokMatch = body.match(/(?:^|&)aura\.token=([^&]*)/);
    try {
      const parsed = JSON.parse(decodeURIComponent(msgMatch[1]));
      const actions = parsed?.actions;
      if (!Array.isArray(actions)) return null;
      for (const action of actions) {
        const sql =
          action?.params?.sql ??        // confirmed shape
          action?.params?.params?.sql;  // fallback for older formats
        if (typeof sql !== 'string' || !sql.trim()) continue;
        return {
          sql: sql.trim(),
          descriptor: action?.descriptor ?? null,
          dataspace: action?.params?.dataspace ?? 'default',
          auraContext: ctxMatch ? ctxMatch[1] : null, // keep raw (URL-encoded)
          auraToken:   tokMatch ? tokMatch[1] : null,
          auraUrl: typeof requestUrl === 'string' ? requestUrl : null,
        };
      }
    } catch (_) {}
    return null;
  }

  /** Remove trailing LIMIT / OFFSET clauses so we can append our own. */
  function stripLimitOffset(sql) {
    return sql
      .replace(/\s+OFFSET\s+\d+\s*$/i, '')
      .replace(/\s+LIMIT\s+\d+\s*$/i, '')
      .trim();
  }

  // CSV helpers live in content-csv.js (loaded before this file).
  const { getColumnNames, triggerDownload, triggerSoqlDownload } = window.__SF_DC_CSV__;

  /**
   * Fetch all rows by re-submitting paginated Aura requests to the same
   * Lightning endpoint that the page itself uses.
   *
   * Because we POST to the same origin (*.lightning.force.com/aura) with the
   * same session cookies, no separate bearer token is needed.  We captured
   * the original aura.context and aura.token from the intercepted request and
   * replay them verbatim, swapping only the SQL (with LIMIT/OFFSET appended).
   *
   * Uses _origFetch to bypass our own patch.
   */
  async function fetchAllRows(acc, { onProgress, onDone, onError }) {
    const BATCH = 49_999;
    const { auraInfo } = acc;

    if (!auraInfo?.auraUrl || !auraInfo?.sql) {
      onError('Missing Aura context — cannot fetch additional rows');
      return;
    }

    const baseSql = stripLimitOffset(auraInfo.sql);
    let allRows = [];
    let allMetadata = acc.metadata;
    let offset = 0;
    let totalRows = acc.totalRows === Infinity ? null : acc.totalRows;
    let pageNum = 0;

    try {
      while (true) {
        pageNum++;
        const paginatedSql = `${baseSql} LIMIT ${BATCH} OFFSET ${offset}`;

        // Reconstruct the form-encoded Aura body with the paginated SQL
        const messageJson = JSON.stringify({
          actions: [{
            id: `${pageNum};a`,
            descriptor: auraInfo.descriptor,
            callingDescriptor: 'UNKNOWN',
            params: {
              sql: paginatedSql,
              rowLimit: BATCH,
              dataspace: auraInfo.dataspace,
            },
          }],
        });

        const bodyParts = [`message=${encodeURIComponent(messageJson)}`];
        if (auraInfo.auraContext) bodyParts.push(`aura.context=${auraInfo.auraContext}`);
        if (auraInfo.auraToken)   bodyParts.push(`aura.token=${auraInfo.auraToken}`);

        let resp;
        try {
          resp = await _origFetch(auraInfo.auraUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: bodyParts.join('&'),
            credentials: 'include',
          });
        } catch (networkErr) {
          onError('Network error: ' + networkErr.message);
          return;
        }

        if (!resp.ok) {
          onError(`Server error ${resp.status}`);
          return;
        }

        let page;
        try {
          page = await resp.json();
        } catch (_) {
          onError('Failed to parse response as JSON');
          return;
        }

        // Aura wraps results in actions[0]; check for Aura-level errors
        const action = page?.actions?.[0];
        if (!action || action.state === 'ERROR') {
          const msg = action?.error?.[0]?.message ?? 'Aura request failed';
          onError(msg.slice(0, 200));
          return;
        }

        const rv = action?.returnValue;
        if (!rv || !Array.isArray(rv.dataRows)) {
          onError('Unexpected response structure');
          return;
        }

        if (!allMetadata && rv.metadata) allMetadata = rv.metadata;
        if (typeof rv.status?.rowCount === 'number') totalRows = rv.status.rowCount;

        const pageRows = rv.dataRows;
        allRows = allRows.concat(pageRows);
        offset += pageRows.length;

        onProgress(allRows.length, totalRows ?? allRows.length);

        if (
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

    onDone(allRows, allMetadata ?? acc.metadata);
  }

  /**
   * Fetch all SOQL rows by chaining through the REST `nextRecordsUrl` links.
   *
   * Each page is a plain GET to the same origin with session cookies.
   * Uses _origFetch to bypass our own patch (avoids re-triggering toasts).
   */
  async function fetchAllSoqlRows(initialRecords, nextRecordsUrl, totalSize, { onProgress, onDone, onError }) {
    let allRecords = [...initialRecords];
    let currentNextUrl = nextRecordsUrl;

    onProgress(allRecords.length, totalSize);

    try {
      while (currentNextUrl) {
        // nextRecordsUrl is a path like /services/data/v66.0/query/01g…-2000
        const fullUrl = currentNextUrl.startsWith('http')
          ? currentNextUrl
          : window.location.origin + currentNextUrl;

        let resp;
        try {
          resp = await _origFetch(fullUrl, {
            credentials: 'include',
            headers: _soqlAuthHeader ? { Authorization: _soqlAuthHeader } : undefined,
          });
        } catch (networkErr) {
          onError('Network error: ' + networkErr.message);
          return;
        }

        if (!resp.ok) {
          onError(`Server error ${resp.status}`);
          return;
        }

        let page;
        try {
          page = await resp.json();
        } catch (_) {
          onError('Failed to parse response as JSON');
          return;
        }

        allRecords = allRecords.concat(page.records ?? []);
        currentNextUrl = page.done ? null : (page.nextRecordsUrl ?? null);
        onProgress(allRecords.length, totalSize);
      }
    } catch (e) {
      onError('Unexpected error: ' + e.message);
      return;
    }

    onDone(allRecords);
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
    const canFetchAll = isLimited && acc.auraInfo != null;

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

    const title = '&#x1F4CA; Query Result Ready';
    const meta = `
      ${acc.returnedRows.toLocaleString()} row${acc.returnedRows !== 1 ? 's' : ''}
      &bull;
      ${columns.length} column${columns.length !== 1 ? 's' : ''}
      ${acc.queryId ? `&bull; <code style="font-size:11px">${acc.queryId.slice(-12)}</code>` : ''}
    `;
    window.__SF_DC_TOAST__.buildShadow(shadow, { title, meta, actionsHtml });

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
          onDone(allRows, metadata) {
            const fullAcc = {
              queryId: acc.queryId,
              dataRows: allRows,
              metadata: metadata,
              returnedRows: allRows.length,
              totalRows: allRows.length,
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

  /**
   * In-page toast for REST SOQL query results (Developer Console, etc.).
   * Same Shadow DOM approach as showToast; data is the raw SOQL response object.
   */
  function showSoqlToast(data) {
    if (currentToastHost) {
      currentToastHost.remove();
      currentToastHost = null;
    }

    const { records, totalSize, nextRecordsUrl } = data;
    const columns = records.length > 0
      ? Object.keys(records[0]).filter((k) => k !== 'attributes')
      : [];
    const isLimited = !data.done;
    const canFetchAll = isLimited && !!nextRecordsUrl;

    const host = document.createElement('div');
    host.setAttribute('data-sf-dc-csv-exporter', '');
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const actionsHtml = isLimited
      ? `
        <div class="warning-banner">
          Showing ${records.length.toLocaleString()} of ${totalSize.toLocaleString()} rows &mdash; query limit hit
        </div>
        <div class="actions">
          ${canFetchAll ? `<button class="btn btn-fetch-all" id="fetchAll">Fetch all ${totalSize.toLocaleString()} rows</button>` : ''}
          <button class="btn btn-download-limited" id="download">Download ${records.length.toLocaleString()} rows</button>
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

    const title = '&#x1F4CA; SOQL Query Result Ready';
    const meta = `
      ${records.length.toLocaleString()} row${records.length !== 1 ? 's' : ''}
      &bull;
      ${columns.length} column${columns.length !== 1 ? 's' : ''}
      ${records[0]?.attributes?.type ? `&bull; <code style="font-size:11px">${records[0].attributes.type}</code>` : ''}
    `;
    window.__SF_DC_TOAST__.buildShadow(shadow, { title, meta, actionsHtml });

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
      animateClose(() => triggerSoqlDownload(records));
    });

    const fetchAllBtn = shadow.getElementById('fetchAll');
    if (fetchAllBtn) {
      fetchAllBtn.addEventListener('click', () => {
        fetchAllBtn.disabled = true;
        shadow.getElementById('download').disabled = true;
        shadow.getElementById('dismiss').disabled = true;
        shadow.getElementById('close').disabled = true;
        shadow.getElementById('progressWrap').style.display = 'block';

        fetchAllSoqlRows(records, nextRecordsUrl, totalSize, {
          onProgress(fetched, total) {
            const pct = total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : 0;
            shadow.getElementById('progressFill').style.width = pct + '%';
            shadow.getElementById('progressText').textContent =
              `Fetching… ${fetched.toLocaleString()} / ${total.toLocaleString()} rows (${pct}%)`;
          },
          onDone(allRecords) {
            animateClose(() => triggerSoqlDownload(allRecords));
          },
          onError(message) {
            shadow.getElementById('progressFill').style.width = '0%';
            const pt = shadow.getElementById('progressText');
            pt.textContent = message;
            pt.classList.add('error');
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

  // Most recently captured Authorization header from a SOQL REST XHR request.
  // Re-used when paginating through nextRecordsUrl in fetchAllSoqlRows because
  // our _origFetch calls don't carry the session cookie alone — the Dev Console
  // REST endpoint requires an explicit "Authorization: OAuth <sessionId>" header.
  let _soqlAuthHeader = null;

  // Tooling API queries from the Dev Console's "Use Tooling API" checkbox follow
  // the same two-step pattern as regular queries: a columns=true preflight fires
  // first, then the actual data request.  Background tooling queries (ApexClass,
  // ApexOrgWideCoverage, etc.) go straight to the data request with no preflight.
  // We arm this flag on the preflight request and consume it on the data response,
  // so only user-initiated tooling queries produce a toast.
  let _toolingQueryArmed = false;

  function processResponse(data, requestUrl, auraInfo = null) {
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
          auraInfo: auraInfo ?? null,
        });
      }

      const acc = store.get(queryId);
      acc.dataRows.push(...payload.dataRows);
      acc.returnedRows += thisPageRows;

      // Refresh totalRows if a better value arrives (e.g., in the 2nd response)
      if (totalRows !== null) acc.totalRows = totalRows;

      // Keep the metadata from the first response that has it
      if (!acc.metadata && payload.metadata) acc.metadata = payload.metadata;

      // auraInfo arrives with the request; update if we missed it the first time
      if (auraInfo && !acc.auraInfo) acc.auraInfo = auraInfo;

      if (acc.returnedRows >= acc.totalRows) {
        // All rows received — flush immediately
        if (acc._flushTimer) clearTimeout(acc._flushTimer);
        store.delete(queryId);
        showToast(acc);
      } else if (acc.returnedRows > 0) {
        // We have rows but haven't hit totalRows yet.  The server may have
        // silently capped the result (e.g. the automatic 1 000-row limit), so
        // no further response will arrive.  Arm a 1.5-second timeout: if nothing
        // else comes in for this queryId we flush whatever we have.
        // Normal multi-page queries return their remaining rows within
        // milliseconds, so the timer will be cancelled long before it fires.
        if (acc._flushTimer) clearTimeout(acc._flushTimer);
        acc._flushTimer = setTimeout(() => {
          if (!store.has(queryId)) return; // already flushed
          store.delete(queryId);
          showToast(acc);
        }, 1_500);
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
    }
  }

  /**
   * Process a REST SOQL response (Developer Console Query Editor only).
   *
   * Three URL-based guards prevent false positives:
   *
   *  1. Tooling API  — background queries in the Developer Console use
   *     /services/data/vXX/tooling/query/ instead of /query/.
   *
   *  2. Metadata preflight — when the user clicks Execute the Dev Console
   *     first fires a request with &columns=true that returns column metadata,
   *     not records.  The actual record response comes in a second request
   *     without that parameter.
   *
   *  3. Continuation fetches — nextRecordsUrl paths like /query/01g…-2000 are
   *     fetched internally by fetchAllSoqlRows; intercepting them here would
   *     produce duplicate toasts.
   */
  function processSoqlResponse(data, requestUrl) {
    if (!isSoqlQueryResponse(data)) return;
    if (data.records.length === 0) return;

    if (typeof requestUrl === 'string') {
      if (/[?&]columns=true/.test(requestUrl)) return;             // 1. Metadata preflight (no records)
      if (/\/query\/[A-Za-z0-9]+-\d+/.test(requestUrl)) return;   // 2. Continuation fetch

      // Tooling API: allow only if armed by a preceding columns=true preflight.
      // Background queries (ApexClass, ApexOrgWideCoverage, …) skip the preflight
      // entirely and will never arm the flag, so they stay filtered out.
      if (/\/tooling\/query[/?]/.test(requestUrl)) {
        if (_toolingQueryArmed) {
          _toolingQueryArmed = false; // consume — one toast per Execute click
        } else {
          return; // background tooling query
        }
      }
    }

    showSoqlToast(data);
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
    const auraInfo = extractAuraInfo(args[1]?.body ?? null, requestUrl);

    // Arm tooling query flag when the columns=true preflight fires via fetch
    if (/\/tooling\/query[/?]/.test(requestUrl) && /[?&]columns=true/.test(requestUrl)) {
      _toolingQueryArmed = true;
    }

    const response = await _origFetch.apply(this, args);

    // Clone so we don't consume the body the page expects
    try {
      response
        .clone()
        .json()
        .then((data) => {
          processResponse(data, requestUrl, auraInfo);
          processSoqlResponse(data, requestUrl);
        })
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
    // args[2] is the async flag; false means synchronous (default: true)
    this[NS + '_async'] = args[2] !== false;
    return _origOpen.apply(this, args);
  };

  const _origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Capture the Authorization header from SOQL REST requests so fetchAllSoqlRows
    // can replay it on nextRecordsUrl continuation GETs.
    if (
      name.toLowerCase() === 'authorization' &&
      typeof this[NS + '_url'] === 'string' &&
      /\/services\/data\//.test(this[NS + '_url'])
    ) {
      _soqlAuthHeader = value;
    }
    return _origSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    // Synchronous XHRs (async=false) are not used by Salesforce query APIs.
    // Chrome throws a NetworkError when a synchronous XHR is sent during page
    // dismissal (e.g. Salesforce saving IDEWorkspace state on unload).
    // Bypass all extension logic for sync XHRs and swallow that specific error
    // so it doesn't surface as an error attributed to content.js.
    if (!this[NS + '_async']) {
      try {
        return _origSend.apply(this, args);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NetworkError') return;
        throw e;
      }
    }

    // args[0] is the request body — a plain string for form-encoded Aura POSTs
    this[NS + '_auraInfo'] = extractAuraInfo(args[0] ?? null, this[NS + '_url']);

    // Arm tooling query flag when the columns=true preflight fires via XHR
    if (
      typeof this[NS + '_url'] === 'string' &&
      /\/tooling\/query[/?]/.test(this[NS + '_url']) &&
      /[?&]columns=true/.test(this[NS + '_url'])
    ) {
      _toolingQueryArmed = true;
    }

    this.addEventListener('load', () => {
      if (this.status < 200 || this.status >= 300) return;
      const ct = this.getResponseHeader('content-type') || '';
      if (!ct.includes('json')) return;
      try {
        const parsed = JSON.parse(this.responseText);
        processResponse(parsed, this[NS + '_url'], this[NS + '_auraInfo']);
        processSoqlResponse(parsed, this[NS + '_url']);
      } catch (_) {}
    });
    return _origSend.apply(this, args);
  };

  // ─────────────────────────────────────────────────────────────────────────────

  console.debug('[SF CSV Exporter] Initialized – monitoring query responses');
})();
