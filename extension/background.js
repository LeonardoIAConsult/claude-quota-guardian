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
    // Show the badge only when there IS an account-wide reading. topPct is null
    // when the response carried no gating window -- clear the badge rather than
    // show a reassuring "0".
    if (!u.ok || u.topPct == null) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.storage.local.set({ lastUsage: u, lastError: u.ok ? null : u.reason, updatedAt: Date.now() });
      return u;
    }
    const p = Math.round(u.topPct);
    await chrome.action.setBadgeText({ text: String(p) });
    await chrome.action.setBadgeBackgroundColor({ color: badgeColor(p) });
    await chrome.storage.local.set({ lastUsage: u, lastError: null, updatedAt: Date.now() });
    return u;
  } catch (e) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.storage.local.set({ lastError: String(e && e.message || e), updatedAt: Date.now() });
    return { ok: false, reason: 'worker-error' };
  }
}

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); refresh(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refresh(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) refresh(); });

// The popup asks the worker to do the single fetch (which also updates the
// badge) and hands back the result, so the popup never fires its own duplicate
// request.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'refresh') {
    refresh().then((usage) => sendResponse({ ok: true, usage }));
    return true; // async response
  }
  if (msg && msg.type === 'cache') {
    readCache().then(sendResponse);
    return true; // async response
  }
  return false;
});

// Prompt-cache countdown of the user's Claude Code sessions. The browser cannot
// read local files, so it asks Guardian's native host (native-host/, registered
// by `node bin/install.js`), which answers with project names and minutes only.
const NATIVE_HOST = 'com.leonardoantolinez.quota_guardian';

async function readCache() {
  try {
    const reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'cache' });
    if (!reply || reply.ok !== true || !Array.isArray(reply.sessions)) return { ok: false, reason: 'host-error' };
    return { ok: true, disabled: Boolean(reply.disabled), sessions: reply.sessions, fetchedAt: Date.now() };
  } catch (_) {
    // "Specified native messaging host not found" and friends: bridge not installed
    return { ok: false, reason: 'no-host' };
  }
}
