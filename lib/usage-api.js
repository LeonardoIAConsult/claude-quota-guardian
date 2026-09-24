'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const paths = require('./paths');
const { atomicWriteFileSync } = require('./atomic-write');

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

const MAX_BACKOFF_MS = 15 * 60 * 1000;

function readShared() {
  try {
    return JSON.parse(fs.readFileSync(paths.apiUsageCachePath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeShared(obj) {
  try {
    const file = paths.apiUsageCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(obj));
  } catch {
    // best-effort: a failed write only costs an extra fetch next time
  }
}

function fetchedMs(reading) {
  const t = reading && reading.fetchedAt ? Date.parse(reading.fetchedAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

const CLOCK_SKEW_MS = 60 * 1000;

function validPct(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100;
}

// Readings come back from disk (api-usage.json and each project's state.json),
// so they are untrusted. A clock that ran ahead stamps a future fetchedAt, which
// would read as "fresh" until that date and outrank every real reading --
// letting a stale low number lift blocks in every project. A corrupted file can
// hold any shape. Anything off is dropped, which fails closed into a refetch.
function sanitizeReading(r, nowMs) {
  if (!r || typeof r !== 'object' || !validPct(r.pct)) return null;
  const t = fetchedMs(r);
  if (!Number.isFinite(t) || t > nowMs + CLOCK_SKEW_MS) return null;
  const okWindow = (w) => Boolean(w && typeof w === 'object' && validPct(w.pct));
  return {
    ...r,
    windows: Array.isArray(r.windows) ? r.windows.filter(okWindow) : null,
    scoped: Array.isArray(r.scoped) ? r.scoped.filter(okWindow) : null,
  };
}

// Time-throttled wrapper. Hooks fire on every PostToolUse/Stop but the quota is
// one per ACCOUNT, so the last reading lives in a single shared file
// (api-usage.json) instead of once per project -- N busy projects no longer
// mean N fetches a minute. The caller's per-project cachedApi (state.json) is
// still honored, whichever is newer wins. A reading whose resets_at has passed
// is force-refreshed (its utilization is no longer real) and never reused as a
// stale fallback.
//
// Failed network attempts (429 rate_limit_error, 5xx, offline) arm an
// exponential backoff shared by every session: without it, each tool call in
// each project re-spawned a fetch and kept the endpoint answering 429.
function getThrottledUsage({ cacheSeconds = 60, timeoutMs, cachedApi, nowMs = Date.now() } = {}) {
  const shared = readShared();
  const sharedReading = sanitizeReading(shared.reading, nowMs);
  const best = [sharedReading, sanitizeReading(cachedApi, nowMs)]
    .reduce((a, b) => (fetchedMs(b) > fetchedMs(a) ? b : a), null);
  const usable = Boolean(best && !rolledOver(best, nowMs));

  if (usable && (nowMs - fetchedMs(best)) < cacheSeconds * 1000) {
    return { ...best, available: true, due: false };
  }

  // Clamped on read: a corrupted value, or one written while the clock ran
  // ahead, must never park quota detection (and with it the block) for longer
  // than one maximum backoff.
  const backoffUntil = Number(shared.backoffUntil);
  if (Number.isFinite(backoffUntil) && nowMs < backoffUntil && backoffUntil - nowMs <= MAX_BACKOFF_MS) {
    return usable
      ? { ...best, available: true, due: false }
      : { available: false, reason: 'backoff', due: false };
  }

  const result = fetchUsage({ timeoutMs });
  if (result.available) {
    writeShared({ reading: result, failures: 0, backoffUntil: null });
    return { ...result, due: true };
  }

  // The fetch can take seconds; another session may have stored a newer, good
  // reading meanwhile. Re-read so a failure never overwrites it with the older
  // copy read above -- that would hand every project a stale (lower) number
  // for the whole backoff.
  const latest = readShared();
  const latestReading = sanitizeReading(latest.reading, nowMs);
  if (latestReading && fetchedMs(latestReading) > fetchedMs(sharedReading) && !rolledOver(latestReading, nowMs)) {
    return { ...latestReading, available: true, due: true };
  }

  // No token = no request was sent; nothing to back off from, and the CLI's
  // token refresh must be picked up on the very next check.
  if (result.reason !== 'no-credentials') {
    const prevFailures = Math.min(20, Math.max(0, Math.floor(Number(latest.failures) || 0)));
    const failures = prevFailures + 1;
    const backoffMs = Math.min(cacheSeconds * 1000 * 2 ** failures, MAX_BACKOFF_MS);
    writeShared({
      reading: fetchedMs(latestReading) >= fetchedMs(sharedReading) ? latestReading : sharedReading,
      failures,
      backoffUntil: nowMs + backoffMs,
      lastError: result.reason,
    });
  }

  // A stale exact reading beats falling back to estimation over one blip --
  // unless the window already reset, in which case the stale number lies.
  if (usable) return { ...best, available: true, due: true };
  return { ...result, due: true };
}

module.exports = { fetchUsage, getThrottledUsage, readAccessToken, credentialsPath };
