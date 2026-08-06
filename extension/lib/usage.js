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

  async function getOrgId() {
    const orgs = await fetch(`${CLAUDE}/api/organizations`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!Array.isArray(orgs) || !orgs.length) return null;
    // Prefer an org that actually has the chat capability (the one that carries
    // consumption); fall back to the first with a uuid.
    const withChat = orgs.find(
      (o) => o && o.uuid && Array.isArray(o.capabilities) && o.capabilities.includes('chat')
    );
    return (withChat || orgs.find((o) => o && o.uuid) || orgs[0]).uuid;
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

  async function fetchUsage() {
    let orgId;
    try {
      orgId = await getOrgId();
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!orgId) return { ok: false, reason: 'not-logged-in' };

    let res;
    try {
      res = await fetch(`${CLAUDE}/api/organizations/${orgId}/usage`, { credentials: 'include' });
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'not-logged-in' };
    if (!res.ok) return { ok: false, reason: 'http-' + res.status };

    let raw;
    try {
      raw = await res.json();
    } catch {
      return { ok: false, reason: 'bad-json' };
    }

    const windows = windowsFrom(raw);
    if (!windows.length) return { ok: false, reason: 'no-windows' };
    const blocking = windows.filter((w) => w.blocking);
    const scoped = windows.filter((w) => !w.blocking);
    const topPct = blocking.length ? blocking.reduce((a, b) => (b.pct > a.pct ? b : a)).pct : 0;
    return { ok: true, windows, blocking, scoped, topPct, fetchedAt: Date.now() };
  }

  root.GuardianUsage = { fetchUsage, getOrgId, windowsFrom, clampPct };
})(typeof self !== 'undefined' ? self : globalThis);
