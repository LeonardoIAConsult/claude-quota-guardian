// Service worker: keeps the toolbar badge showing the most-pressing quota % so
// the user sees consumption at a glance without opening the popup. Polls on a
// modest cadence (the data only moves as the user consumes quota). All data
// comes from the user's own claude.ai session -- see lib/usage.js.
importScripts('lib/usage.js');

const ALARM = 'guardian-refresh';
const PERIOD_MINUTES = 2;

function badgeColor(pct) {
  if (pct >= 90) return '#c0392b'; // red -- near the cap
  if (pct >= 70) return '#e67e22'; // orange -- getting close
  return '#2d7d46'; // green -- healthy
}

async function refresh() {
  try {
    const u = await self.GuardianUsage.fetchUsage();
    if (!u.ok) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.storage.local.set({ lastUsage: u, lastError: u.reason, updatedAt: Date.now() });
      return;
    }
    const p = Math.round(u.topPct);
    await chrome.action.setBadgeText({ text: String(p) });
    await chrome.action.setBadgeBackgroundColor({ color: badgeColor(p) });
    await chrome.storage.local.set({ lastUsage: u, lastError: null, updatedAt: Date.now() });
  } catch (e) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.storage.local.set({ lastError: String(e && e.message || e), updatedAt: Date.now() });
  }
}

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); refresh(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refresh(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) refresh(); });

// Let the popup ask for an immediate refresh.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'refresh') {
    refresh().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});
