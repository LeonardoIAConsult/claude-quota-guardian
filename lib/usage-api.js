'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const paths = require('./paths');

// Same endpoint the CLI's own /usage command hits (string present in the CLI
// binary). Undocumented, so every failure path here degrades to Guardian's
// older signals (statusline rate_limits cache, ccusage) instead of erroring.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// The HTTPS GET runs in a `node -e` child so the synchronous hook flow
// (performCheck) can consume it without going async. Token travels via stdin:
// never argv (visible in process listings), never env (inherited by
// grandchildren).
const FETCH_SCRIPT = `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const { token, timeoutMs } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const res = await fetch('${USAGE_URL}', {
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(timeoutMs || 5000),
    });
    if (!res.ok) {
      process.stdout.write(JSON.stringify({ error: 'http-' + res.status }));
      return;
    }
    process.stdout.write(JSON.stringify({ data: await res.json() }));
  } catch {
    process.stdout.write(JSON.stringify({ error: 'fetch-failed' }));
  }
});
`;

function credentialsPath() {
  return path.join(paths.claudeHome(), '.credentials.json');
}

function readCredsFromFile() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
  } catch {
    return null;
  }
}

// macOS keeps the Claude Code OAuth credentials in the login Keychain, not in
// ~/.claude/.credentials.json. Read them with the `security` CLI so Guardian's
// quota detection works for Mac users too. Best-effort: any failure (not on
// darwin, entry absent, tool missing) falls through to null exactly like a
// missing file on Windows/Linux, so the caller degrades to its other signals.
function readCredsFromKeychain() {
  if (process.platform !== 'darwin') return null;
  for (const service of ['Claude Code-credentials', 'Claude Code']) {
    try {
      const out = cp.execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        windowsHide: true,
      });
      const parsed = JSON.parse(out);
      if (parsed) return parsed;
    } catch {
      // try the next service name, then fall through to null
    }
  }
  return null;
}

// Whatever plan the installing user has (Pro / Max / Team), the OAuth token is
// the same shape and the usage endpoint returns THAT account's real limits --
// so reading the token is all Guardian needs to auto-detect any user's quota.
function readCreds() {
  return readCredsFromFile() || readCredsFromKeychain();
}

function readAccessToken() {
  try {
    const creds = readCreds();
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    // An expired token would only earn a 401 -- skip the round-trip. The CLI
    // refreshes the token (file or Keychain), so the next check reads the new one.
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

function clampPct(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
}

function normalizeWindow(w) {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  return {
    pct: clampPct(w.utilization),
    resetAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  };
}

// The `limits[]` array is the authoritative, forward-compatible list of every
// quota window the account has: `session` (5h), `weekly_all` (7d across all
// models), and `weekly_scoped` per-model caps (e.g. Fable). Split by role:
//   - blocking windows (session + weekly_all) gate EVERY model, so the highest
//     of them drives the hard block.
//   - scoped windows gate a single model; exhausting one still leaves other
//     models usable, so they are advisory (notify-only), never a block.
function windowsFromLimits(limits) {
  if (!Array.isArray(limits)) return null;
  const windows = [];
  for (const l of limits) {
    const pct = clampPct(l && l.percent);
    if (pct === null || !l.kind) continue;
    const model = (l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.id)) || null;
    const surface = (l.scope && l.scope.surface
      && (l.scope.surface.display_name || l.scope.surface.id || (typeof l.scope.surface === 'string' ? l.scope.surface : null))) || null;
    // A window BLOCKS iff it is account-wide -- i.e. it has no scope narrowing it
    // to one model or surface. Deciding by scope (not by matching hardcoded kind
    // strings) is forward-compatible: any future account-wide window Anthropic
    // adds is treated as blocking, and any new per-model/surface cap as advisory,
    // without a code change.
    const isScoped = Boolean(model || surface);
    let label = l.kind;
    if (model) label = model;
    else if (surface) label = surface;
    else if (l.kind === 'session') label = 'Sesión';
    else if (l.kind === 'weekly_all') label = 'Semanal';
    else if (l.kind && l.kind.startsWith('weekly')) label = 'Semanal';
    windows.push({
      kind: l.kind,
      label,
      pct,
      resetAt: typeof l.resets_at === 'string' ? l.resets_at : null,
      blocking: !isScoped,
      model,
    });
  }
  return windows.length ? windows : null;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const fiveHour = normalizeWindow(raw.five_hour);
  const sevenDay = normalizeWindow(raw.seven_day);

  // Prefer the rich limits[] list; fall back to the flat five_hour/seven_day
  // fields when an older API response omits it.
  const fromLimits = windowsFromLimits(raw.limits);
  const windows = fromLimits || [
    fiveHour && { kind: 'session', label: 'Sesión', pct: fiveHour.pct, resetAt: fiveHour.resetAt, blocking: true, model: null },
    sevenDay && { kind: 'weekly_all', label: 'Semanal', pct: sevenDay.pct, resetAt: sevenDay.resetAt, blocking: true, model: null },
  ].filter(Boolean);

  const blocking = windows.filter((w) => w.blocking);
  const scoped = windows.filter((w) => !w.blocking);
  if (!blocking.length) return null;

  // Hard-block signal = the most-pressing account-gating window (session or
  // weekly_all). Scoped/per-model windows are carried for advisory notify only.
  const top = blocking.reduce((a, b) => (b.pct > a.pct ? b : a));
  return { pct: top.pct, resetAt: top.resetAt, topWindow: top, fiveHour, sevenDay, windows, scoped };
}

function fetchUsage({ timeoutMs = 5000 } = {}) {
  const token = readAccessToken();
  if (!token) return { available: false, reason: 'no-credentials' };

  let out;
  try {
    out = cp.execFileSync(process.execPath, ['-e', FETCH_SCRIPT], {
      input: JSON.stringify({ token, timeoutMs }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs + 3000,
      windowsHide: true,
    });
  } catch {
    return { available: false, reason: 'fetch-failed' };
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { available: false, reason: 'bad-output' };
  }
  if (parsed.error) return { available: false, reason: parsed.error };

  const normalized = normalize(parsed.data);
  if (!normalized) return { available: false, reason: 'no-usage-windows' };
  return { available: true, ...normalized, fetchedAt: new Date().toISOString() };
}

function rolledOver(cachedApi, nowMs) {
  return Boolean(cachedApi && cachedApi.resetAt && nowMs >= Date.parse(cachedApi.resetAt));
}

// Time-throttled wrapper. Hooks fire on every PostToolUse/Stop but the API
// only needs polling every cacheSeconds; cachedApi round-trips through
// state.json (this module is stateless, like the ccusage throttle). A cache
// whose resets_at has passed is force-refreshed (the window rolled over, so
// its utilization is no longer real) and never reused as a stale fallback.
function getThrottledUsage({ cacheSeconds = 60, timeoutMs, cachedApi, nowMs = Date.now() } = {}) {
  const fresh = cachedApi && typeof cachedApi.pct === 'number' && cachedApi.fetchedAt
    && (nowMs - new Date(cachedApi.fetchedAt).getTime()) < cacheSeconds * 1000
    && !rolledOver(cachedApi, nowMs);
  if (fresh) return { ...cachedApi, available: true, due: false };

  const result = fetchUsage({ timeoutMs });
  if (result.available) return { ...result, due: true };

  // A stale exact reading beats falling back to estimation over one blip --
  // unless the window already reset, in which case the stale number lies.
  if (cachedApi && typeof cachedApi.pct === 'number' && !rolledOver(cachedApi, nowMs)) {
    return { ...cachedApi, available: true, due: true };
  }
  return { ...result, due: true };
}

module.exports = { fetchUsage, getThrottledUsage, readAccessToken, credentialsPath };
