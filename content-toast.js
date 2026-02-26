/**
 * content-toast.js — Shared toast template for SF Query Editor Helper.
 *
 * Loaded before content.js in the MAIN "world" (same JS execution context).
 * Exposes window.__SF_DC_TOAST__.buildShadow so both showToast (DC queries)
 * and showSoqlToast (Developer Console queries) share one copy of the CSS
 * and one copy of the DOM skeleton.
 */
window.__SF_DC_TOAST__ = (function () {
  'use strict';

  const CSS = `
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

    .btn-copy {
      background: #fff;
      color: #706e6b;
      border-color: #dddbda;
    }
    .btn-copy:hover:not(:disabled) { background: #f3f2f2; }

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
  `;

  /**
   * Populate a Shadow DOM root with the standard toast skeleton.
   *
   * @param {ShadowRoot} shadow   - Already-attached shadow root to write into.
   * @param {string}     title    - Pre-computed HTML for the toast title.
   * @param {string}     meta     - Pre-computed HTML for the subtitle line.
   * @param {string}     actionsHtml - Pre-computed HTML for buttons / progress bar.
   */
  function buildShadow(shadow, { title, meta, actionsHtml }) {
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="toast" id="toast">
        <div class="header">
          <span class="title">${title}</span>
          <button class="close-btn" id="close" title="Dismiss">&times;</button>
        </div>
        <div class="meta">${meta}</div>
        ${actionsHtml}
      </div>
    `;
  }

  return { buildShadow };
})();
