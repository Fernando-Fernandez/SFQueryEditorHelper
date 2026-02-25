/**
 * background.js – Manifest V3 Service Worker
 *
 * Tracks how many DC query results have been intercepted per tab.
 * Displays the count as an action-button badge so users know there
 * are downloadable results even if they've dismissed the in-page toast.
 *
 * State is kept in chrome.storage.session (survives worker sleep/wake
 * cycles but is cleared when the browser session ends).
 */
'use strict';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function storageKey(tabId) {
  return `tab_${tabId}`;
}

async function getCount(tabId) {
  const key = storageKey(tabId);
  const result = await chrome.storage.session.get(key);
  return result[key] ?? 0;
}

async function setCount(tabId, count) {
  await chrome.storage.session.set({ [storageKey(tabId)]: count });
}

async function clearTab(tabId) {
  await chrome.storage.session.remove(storageKey(tabId));
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (_) {
    // Tab may already be gone
  }
}

async function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0176d3' });
  await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'QUERY_READY') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    (async () => {
      const count = (await getCount(tabId)) + 1;
      await setCount(tabId, count);
      await updateBadge(tabId, count);
    })();

    // Return true to keep the message channel open for async ops (not needed
    // here since we don't call sendResponse, but good practice)
    return false;
  }

  // Popup asks for the current count for the active tab
  if (message.type === 'GET_COUNT') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ count: 0 });
      return false;
    }
    getCount(tabId).then((count) => sendResponse({ count }));
    return true; // async sendResponse
  }
});

// ─── Clear badge on navigation ────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only reset when the tab starts a new navigation (not on every status change)
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
});
