/**
 * popup.js
 *
 * Asks the background service worker for the query-intercept count of the
 * current tab and updates the status card accordingly.
 */
(async () => {
  'use strict';

  // Get the active tab so we can ask the background for its specific count
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) return;

  let count = 0;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_COUNT',
      tabId: tab.id,
    });
    count = response?.count ?? 0;
  } catch (_) {
    // Service worker may not be awake yet; count stays 0
  }

  const card       = document.getElementById('statusCard');
  const icon       = document.getElementById('statusIcon');
  const countEl    = document.getElementById('statusCount');
  const labelEl    = document.getElementById('statusLabel');

  if (count > 0) {
    card.classList.add('has-results');
    icon.style.display  = 'none';
    countEl.style.display = 'block';
    countEl.textContent = String(count);
    labelEl.textContent =
      count === 1
        ? 'query result intercepted'
        : 'query results intercepted';
  } else {
    const isSalesforcePage =
      tab.url && (
        tab.url.includes('salesforce.com') ||
        tab.url.includes('force.com')
      );

    if (!isSalesforcePage) {
      icon.textContent = '&#x26A0;&#xFE0F;';
      labelEl.innerHTML =
        'Navigate to a <strong>Salesforce</strong> page first.';
    }
    // Otherwise keep the default "waiting" state
  }
})();
