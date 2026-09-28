// Shared usage fetch + normalize for the Guardian monitor extension.
//
// It calls the SAME endpoint claude.ai's own "Uso" screen uses
// (`/api/organizations/<org>/usage`), authenticated by the user's existing
// session cookies via `credentials: 'include'`. No token is ever read, stored,
// or transmitted -- the extension only needs host permission for claude.ai.
//
// The window model mirrors lib/usage-api.js on the CLI side:
//   - account-wide windows (no scope) BLOCK conceptually -> shown as main bars.
//   - scoped windows (per model, e.g. Fable, or per surface) are advisory.
// Attached to globalThis so both the popup (<script>) and the service worker
// (importScripts) can use it.
(function (root) {
  const CLAUDE = 'https://claude.ai';

  function clampPct(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    return Math.max(0, Math.min(100, x));
  }

  // Ordered list of candidate org ids to try: chat-capable orgs first (the ones
  // that carry consumption), then any other org with a uuid. Trying in order and
  // using the first that actually returns usage windows is robust for users in
  // multiple orgs (e.g. a Team org + personal) where the consuming org may not
  // advertise a 'chat' capability.
  async function getOrgIds() {
    const orgs = await fetch(`${CLAUDE}/api/organizations`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null));
    if (!Array.isArray(orgs) || !orgs.length) return [];
    const chat = orgs
      .filter((o) => o && o.uuid && Array.isArray(o.capabilities) && o.capabilities.includes('chat'))
      .map((o) => o.uuid);
    const rest = orgs.filter((o) => o && o.uuid).map((o) => o.uuid);
    return [...new Set([...chat, ...rest])];
  }

  // Back-compat single-id helper.
  async function getOrgId() {
    const ids = await getOrgIds().catch(() => []);
    return ids[0] || null;
  }

  function windowsFrom(raw) {
    const windows = [];
    const push = (kind, label, pct, resetAt, blocking, model) => {
      const p = clampPct(pct);
      if (p === null) return;
      windows.push({ kind, label, pct: p, resetAt: resetAt || null, blocking, model: model || null });
    };

    if (raw && Array.isArray(raw.limits) && raw.limits.length) {
      for (const l of raw.limits) {
        if (!l || !l.kind) continue;
        const model = l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.id);
        const surface = l.scope && l.scope.surface && (l.scope.surface.display_name || l.scope.surface.id);
        const scoped = Boolean(model || surface);
        let label = model || surface || l.kind;
        if (!scoped && l.kind === 'session') label = 'Sesión';
        else if (!scoped && l.kind.startsWith('weekly')) label = 'Semanal';
        push(l.kind, label, l.percent, l.resets_at, !scoped, model);
      }
    }

    // Fallback for a response shape without limits[].
    if (!windows.length && raw) {
      if (raw.five_hour) push('session', 'Sesión', raw.five_hour.utilization, raw.five_hour.resets_at, true);
      if (raw.seven_day) push('weekly_all', 'Semanal', raw.seven_day.utilization, raw.seven_day.resets_at, true);
    }
    return windows;
  }

  // Dollar credits (e.g. the cloud-session promo credit) are top-level entries
  // under internal codenames that can change, so they are recognized by SHAPE
  // (positive limit_dollars + numeric used/remaining), never by name. Mirrors
  // creditsFrom() in lib/usage-api.js. Informational only: never in the badge.
  const CREDIT_LABELS = { iguana_necktie: 'Crédito nube' };

  function num(x) {
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  }

  function creditsFrom(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const credits = [];
    for (const [key, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const limit = num(v.limit_dollars);
      if (limit === null || limit <= 0) continue;
      let used = num(v.used_dollars);
      let remaining = num(v.remaining_dollars);
      if (used === null && remaining === null) continue;
      if (used === null) used = limit - remaining;
      if (remaining === null) remaining = limit - used;
      credits.push({
        key,
        label: Object.hasOwn(CREDIT_LABELS, key) ? CREDIT_LABELS[key] : 'Crédito promocional',
        limit,
        used: Math.max(0, used),
        remaining: Math.max(0, remaining),
        pct: clampPct((used / limit) * 100),
        expiresAt: typeof v.resets_at === 'string' ? v.resets_at : null,
      });
    }
    return credits;
  }

  async function fetchUsage() {
    let ids;
    try {
      ids = await getOrgIds();
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!ids.length) return { ok: false, reason: 'not-logged-in' };

    // Try each candidate org until one returns real usage windows.
    let lastReason = 'no-windows';
    for (const orgId of ids) {
      let res;
      try {
        res = await fetch(`${CLAUDE}/api/organizations/${orgId}/usage`, { credentials: 'include' });
      } catch {
        lastReason = 'network';
        continue;
      }
      if (res.status === 401 || res.status === 403) { lastReason = 'not-logged-in'; continue; }
      if (!res.ok) { lastReason = 'http-' + res.status; continue; }

      let raw;
      try {
        raw = await res.json();
      } catch {
        lastReason = 'bad-json';
        continue;
      }

      const windows = windowsFrom(raw);
      if (!windows.length) { lastReason = 'no-windows'; continue; }

      const blocking = windows.filter((w) => w.blocking);
      const scoped = windows.filter((w) => !w.blocking);
      // null (not 0) when there is no account-wide window, so the badge can tell
      // "no gating data" apart from a genuine 0%.
      const topPct = blocking.length ? blocking.reduce((a, b) => (b.pct > a.pct ? b : a)).pct : null;
      return { ok: true, windows, blocking, scoped, credits: creditsFrom(raw), topPct, orgId, fetchedAt: Date.now() };
    }
    return { ok: false, reason: lastReason };
  }

  root.GuardianUsage = { fetchUsage, getOrgId, getOrgIds, windowsFrom, creditsFrom, clampPct };
})(typeof self !== 'undefined' ? self : globalThis);
