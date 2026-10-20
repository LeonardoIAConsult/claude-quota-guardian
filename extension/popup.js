// Popup UI. Renders cached data instantly (if any), then asks the service
// worker for a fresh reading. All data comes from the user's own claude.ai
// session via lib/usage.js.

function colorClass(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'orange';
  return 'green';
}

function fmtReset(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = t - Date.now();
  if (diffMs <= 0) return 'reinicia pronto';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `reinicia en ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `reinicia en ${hrs} h ${mins % 60} min`;
  const days = Math.round(hrs / 24);
  return `reinicia en ${days} d`;
}

function rowHtml(w, scoped) {
  const cls = colorClass(w.pct);
  return `
    <div class="row">
      <div class="row-top">
        <span class="row-label">${escapeHtml(w.label)}</span>
        <span class="row-pct">${Math.round(w.pct)}%</span>
      </div>
      <div class="bar"><span class="${cls}" style="width:${Math.max(2, Math.min(100, w.pct))}%"></span></div>
      ${w.resetAt ? `<div class="row-reset">${fmtReset(w.resetAt)}</div>` : ''}
    </div>`;
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function fmtExpiry(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.ceil((t - Date.now()) / 86400000);
  return days > 0 ? `vence en ${days} d` : 'vencido';
}

function creditRowHtml(c) {
  const cls = colorClass(c.pct);
  const expiry = fmtExpiry(c.expiresAt);
  return `
    <div class="row">
      <div class="row-top">
        <span class="row-label">${escapeHtml(c.label)}</span>
        <span class="row-pct">quedan ${fmtUsd(c.remaining)}</span>
      </div>
      <div class="bar"><span class="${cls}" style="width:${Math.max(2, Math.min(100, c.pct))}%"></span></div>
      <div class="row-reset">${fmtUsd(c.used)} usados de ${fmtUsd(c.limit)}${expiry ? ` · ${expiry}` : ''}</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const REASON_TEXT = {
  'not-logged-in': 'Inicia sesión en claude.ai para ver tu consumo.',
  'network': 'Sin conexión con claude.ai.',
  'no-org': 'No se encontró tu cuenta.',
  'no-windows': 'Claude no devolvió datos de cuota.',
  'bad-json': 'Respuesta inesperada de Claude.',
};

function render(u) {
  const statusEl = document.getElementById('status');
  const blockingEl = document.getElementById('blocking');
  const scopedSection = document.getElementById('scoped');
  const scopedRows = document.getElementById('scoped-rows');
  const creditsSection = document.getElementById('credits');
  const creditRows = document.getElementById('credit-rows');

  if (!u || !u.ok) {
    const reason = (u && u.reason) || 'unknown';
    statusEl.textContent = REASON_TEXT[reason] || (reason.startsWith('http-')
      ? `Error de Claude (${reason}).` : 'No se pudo leer el consumo.');
    statusEl.className = 'status error';
    blockingEl.innerHTML = '';
    scopedSection.hidden = true;
    creditsSection.hidden = true;
    return;
  }

  statusEl.className = 'status hidden';
  blockingEl.innerHTML = u.blocking.map((w) => rowHtml(w, false)).join('');

  if (u.scoped && u.scoped.length) {
    scopedRows.innerHTML = u.scoped.map((w) => rowHtml(w, true)).join('');
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

  const updated = document.getElementById('updated');
  updated.textContent = u.fetchedAt ? `Actualizado ${fmtAgo(u.fetchedAt)}` : '';
}

function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'ahora';
  if (s < 60) return `hace ${s}s`;
  const m = Math.round(s / 60);
  return `hace ${m} min`;
}

async function load(forceFresh) {
  const btn = document.getElementById('refresh');
  // 1) instant paint from cache
  const cached = await chrome.storage.local.get('lastUsage');
  if (cached && cached.lastUsage) render(cached.lastUsage);

  // 2) single fresh read: the service worker owns the fetch (and updates the
  //    badge); we just read back what it returns. No duplicate request.
  if (forceFresh) btn.classList.add('spinning');
  let fresh = null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'refresh' });
    if (resp && resp.usage) fresh = resp.usage;
  } catch (_) {
    // worker unavailable -- fall back to whatever is cached
  }
  if (!fresh) {
    const after = await chrome.storage.local.get('lastUsage');
    fresh = (after && after.lastUsage) || { ok: false, reason: 'network' };
  }
  render(fresh);
  btn.classList.remove('spinning');
}

// Bar fill = share of the cache lifetime still left; color follows how close
// the cache is to expiring, not a quota percentage.
function cacheRowHtml(s) {
  const left = Math.max(0, Math.min(100, (s.minutesLeft / s.ttlMinutes) * 100));
  const cls = s.expired ? 'red' : s.warn ? 'orange' : 'green';
  const text = s.expired ? 'vencido' : `quedan ${s.minutesLeft} min`;
  const hint = s.expired
    ? 'El siguiente mensaje vuelve a pagar todo el contexto. Si vas a seguir mucho, haz el traspaso y empieza limpio.'
    : s.warn
      ? 'Envía un mensaje para mantenerlo o haz el traspaso.'
      : `Dura ${s.ttlMinutes} min desde tu último mensaje.`;
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

const CACHE_HINT = {
  'no-host': 'Para ver el caché de Claude Code, instala Guardian en este equipo (node bin/install.js) y reinicia el navegador.',
  'host-error': 'Guardian no pudo leer el caché de Claude Code.',
};

function renderCache(c) {
  const section = document.getElementById('cache');
  const rows = document.getElementById('cache-rows');
  if (!c || c.disabled) {
    section.hidden = true;
    return;
  }
  if (!c.ok) {
    rows.innerHTML = `<div class="row-reset">${escapeHtml(CACHE_HINT[c.reason] || CACHE_HINT['host-error'])}</div>`;
  } else if (c.sessions.length === 0) {
    rows.innerHTML = '<div class="row-reset">Ninguna sesión de Claude Code tiene el caché vivo ahora.</div>';
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
