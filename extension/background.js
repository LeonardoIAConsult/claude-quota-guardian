// Service worker: keeps the toolbar badge showing the most-pressing quota % so
// the user sees consumption at a glance without opening the popup. Polls on a
// modest cadence (the data only moves as the user consumes quota). All data
// comes from the user's own claude.ai session -- see lib/usage.js.
importScripts('lib/usage.js');

const ALARM = 'guardian-refresh';
const PERIOD_MINUTES = 2;

async function paintBadge(good, error) {
  const b = self.GuardianUsage.badgeFor(good, error, Date.now());
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setTitle({ title: b.title });
}

// A failed read (no network, a 429, a 5xx) never overwrites the last good
// reading: it is stored apart in lastError, and the badge and popup keep the
// good numbers marked as not updated. Only a successful read replaces them.
async function doRefresh() {
  const { lastUsage } = await chrome.storage.local.get('lastUsage');
  const good = lastUsage && lastUsage.ok ? lastUsage : null;
  let u;
  try {
    u = await self.GuardianUsage.fetchUsage();
  } catch (e) {
    u = { ok: false, reason: 'worker-error' };
  }
  if (u.ok) {
    await chrome.storage.local.set({ lastUsage: u, lastError: null, updatedAt: Date.now() });
    await paintBadge(u, null);
    return { usage: u, error: null };
  }
  // Signed out (or into another account): the old numbers are not this
  // person's anymore, so they go too.
  if (u.reason === 'not-logged-in') {
    await chrome.storage.local.set({ lastUsage: null, lastError: u.reason, updatedAt: Date.now() });
    await paintBadge(null, u.reason);
    return { usage: null, error: u.reason };
  }
  await chrome.storage.local.set({ lastError: u.reason, updatedAt: Date.now() });
  await paintBadge(good, u.reason);
  return { usage: good, error: u.reason };
}

// The alarm, the popup opening and the refresh button can all ask at once; they
// share one request so an older answer can never land after a newer one.
let inFlight = null;
function refresh() {
  if (!inFlight) {
    inFlight = doRefresh()
      .catch(() => ({ usage: null, error: 'worker-error' }))
      .finally(() => { inFlight = null; });
  }
  return inFlight;
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
    refresh()
      .then((r) => sendResponse({ ok: true, usage: r.usage, error: r.error }))
      .catch(() => sendResponse({ ok: false }));
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
