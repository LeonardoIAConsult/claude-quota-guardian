// Popup UI. Renders cached data instantly (if any), then asks the service
// worker for a fresh reading. All data comes from the user's own claude.ai
// session via lib/usage.js.

const t = self.GuardianUsage.t;

// Static texts of popup.html: data-i18n fills the text, data-i18n-label the
// tooltip and accessible name. The strings live in _locales/<lang>/messages.json.
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-label]')) {
  el.title = t(el.dataset.i18nLabel);
  el.setAttribute('aria-label', el.title);
}

function colorClass(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'orange';
  return 'green';
}

// A window whose reset already passed shows that, not its old % as if current.
function rowHtml(w) {
  if (self.GuardianUsage.isRolledOver(w, Date.now())) {
    return `
    <div class="row">
      <div class="row-top">
        <span class="row-label">${escapeHtml(w.label)}</span>
        <span class="row-pct muted">${escapeHtml(t('resetDone'))}</span>
      </div>
      <div class="bar"><span class="green" style="width:2%"></span></div>
      <div class="row-reset">${escapeHtml(t('rolledNote'))}</div>
    </div>`;
  }
  const cls = colorClass(w.pct);
  return `
    <div class="row">
      <div class="row-top">
        <span class="row-label">${escapeHtml(w.label)}</span>
        <span class="row-pct">${Math.round(w.pct)}%</span>
      </div>
      <div class="bar"><span class="${cls}" style="width:${Math.max(2, Math.min(100, w.pct))}%"></span></div>
      ${w.resetAt ? `<div class="row-reset">${self.GuardianUsage.fmtLeft(w.resetAt, Date.now())}</div>` : ''}
    </div>`;
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function fmtExpiry(iso) {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const days = Math.ceil((at - Date.now()) / 86400000);
  return days > 0 ? t('expiresIn', days) : t('expired');
}

function creditRowHtml(c) {
  const cls = colorClass(c.pct);
  const expiry = fmtExpiry(c.expiresAt);
  return `
    <div class="row">
      <div class="row-top">
        <span class="row-label">${escapeHtml(c.label)}</span>
        <span class="row-pct">${escapeHtml(t('creditLeft', fmtUsd(c.remaining)))}</span>
      </div>
      <div class="bar"><span class="${cls}" style="width:${Math.max(2, Math.min(100, c.pct))}%"></span></div>
      <div class="row-reset">${escapeHtml(t('creditUsed', fmtUsd(c.used), fmtUsd(c.limit)))}${expiry ? ` · ${expiry}` : ''}</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// u: last good reading (or null); error: reason of the latest failed refresh.
// A failure never hides good numbers: they stay, with a note that they are old.
function render(u, error) {
  const statusEl = document.getElementById('status');
  const blockingEl = document.getElementById('blocking');
  const scopedSection = document.getElementById('scoped');
  const scopedRows = document.getElementById('scoped-rows');
  const creditsSection = document.getElementById('credits');
  const creditRows = document.getElementById('credit-rows');
  const updated = document.getElementById('updated');

  if (!u || !u.ok || !Array.isArray(u.blocking)) {
    statusEl.textContent = self.GuardianUsage.reasonText(error || (u && u.reason));
    statusEl.className = 'status error';
    blockingEl.innerHTML = '';
    scopedSection.hidden = true;
    creditsSection.hidden = true;
    updated.textContent = '';
    return;
  }

  blockingEl.innerHTML = u.blocking.map(rowHtml).join('');

  if (u.scoped && u.scoped.length) {
    scopedRows.innerHTML = u.scoped.map(rowHtml).join('');
    scopedSection.hidden = false;
  } else {
    scopedSection.hidden = true;
  }

  if (u.credits && u.credits.length) {
    creditRows.innerHTML = u.credits.map(creditRowHtml).join('');
    creditsSection.hidden = false;
  } else {
    creditsSection.hidden = true;
  }

  if (error) {
    statusEl.textContent = t('staleStatus', self.GuardianUsage.reasonText(error));
    statusEl.className = 'status error';
    updated.textContent = u.fetchedAt ? t('lastReading', fmtAgo(u.fetchedAt)) : '';
  } else {
    statusEl.className = 'status hidden';
    updated.textContent = u.fetchedAt ? t('updatedAgo', fmtAgo(u.fetchedAt)) : '';
  }
}

function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return t('agoNow');
  if (s < 60) return t('agoSec', s);
  const m = Math.round(s / 60);
  return t('agoMin', m);
}

async function load(forceFresh) {
  const btn = document.getElementById('refresh');
  // 1) instant paint from what the worker stored last
  const cached = await chrome.storage.local.get(['lastUsage', 'lastError']);
  const good = cached.lastUsage && cached.lastUsage.ok ? cached.lastUsage : null;
  if (good || cached.lastError) render(good, cached.lastError);

  // 2) single fresh read: the service worker owns the fetch (and updates the
  //    badge); we just read back what it returns. No duplicate request.
  if (forceFresh) btn.classList.add('spinning');
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'refresh' });
  } catch (_) {
    // worker unavailable -- fall back to whatever is stored
  }
  if (resp && resp.ok) {
    render(resp.usage, resp.error);
  } else {
    const after = await chrome.storage.local.get(['lastUsage', 'lastError']);
    const last = after.lastUsage && after.lastUsage.ok ? after.lastUsage : null;
    render(last, after.lastError || (last ? null : 'network'));
  }
  btn.classList.remove('spinning');
}

// Bar fill = share of the cache lifetime still left; color follows how close
// the cache is to expiring, not a quota percentage.
function cacheRowHtml(s) {
  const left = Math.max(0, Math.min(100, (s.minutesLeft / s.ttlMinutes) * 100));
  const cls = s.expired ? 'red' : s.warn ? 'orange' : 'green';
  const text = s.expired ? t('expired') : t('cacheLeft', s.minutesLeft);
  const hint = s.expired
    ? t('cacheExpiredHint')
    : s.warn
      ? t('cacheWarnHint')
      : t('cacheTtlHint', s.ttlMinutes);
  return `
    <div class="row">
      <div class="row-top">
        <span class="row-label">${escapeHtml(s.project)}</span>
        <span class="row-pct">${text}</span>
      </div>
      <div class="bar"><span class="${cls}" style="width:${Math.max(2, left)}%"></span></div>
      <div class="row-reset">${escapeHtml(hint)}</div>
    </div>`;
}

// reason -> message key in _locales
const CACHE_HINT = {
  'no-host': 'hintNoHost',
  'host-error': 'hintHostError',
};

function renderCache(c) {
  const section = document.getElementById('cache');
  const rows = document.getElementById('cache-rows');
  if (!c || c.disabled) {
    section.hidden = true;
    return;
  }
  if (!c.ok) {
    rows.innerHTML = `<div class="row-reset">${escapeHtml(t(CACHE_HINT[c.reason] || CACHE_HINT['host-error']))}</div>`;
  } else if (c.sessions.length === 0) {
    rows.innerHTML = `<div class="row-reset">${escapeHtml(t('cacheEmpty'))}</div>`;
  } else {
    rows.innerHTML = c.sessions.map(cacheRowHtml).join('');
  }
  section.hidden = false;
}

async function loadCache() {
  try {
    renderCache(await chrome.runtime.sendMessage({ type: 'cache' }));
  } catch (_) {
    renderCache({ ok: false, reason: 'host-error' });
  }
}

document.getElementById('refresh').addEventListener('click', () => { load(true); loadCache(); });
load(false);
loadCache();
// The countdown moves by the minute; keep it current while the popup is open.
setInterval(loadCache, 30000);
