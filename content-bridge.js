/**
 * content-bridge.js – runs in the ISOLATED world at document_start
 *
 * Bridges messages from the MAIN-world content.js to the background service
 * worker.  content.js has no access to chrome.* APIs (MAIN world restriction),
 * so it uses window.postMessage; this script picks them up and forwards them
 * via chrome.runtime.sendMessage.
 *
 * Only the lightweight metadata (row/column counts) crosses the bridge –
 * the actual query data stays in the page's memory and is downloaded directly
 * from content.js without ever passing through the extension messaging layer.
 */
(function () {
  'use strict';

  const NS = '__SF_DC_CSV__';

  window.addEventListener('message', (event) => {
    // Only accept messages from the same window (same-page postMessage)
    if (event.source !== window) return;

    const msg = event.data;
    if (!msg || msg.type !== `${NS}:QUERY_READY`) return;

    // Forward lightweight signal to background (no large payloads)
    chrome.runtime.sendMessage({
      type: 'QUERY_READY',
      rowCount: msg.rowCount,
      colCount: msg.colCount,
    });
  });
})();
