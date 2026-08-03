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

function readAccessToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    // An expired token would only earn a 401 -- skip the round-trip. The CLI
    // rewrites this file on refresh, so the next check reads the new token.
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

function normalizeWindow(w) {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  return {
    pct: Math.max(0, Math.min(100, w.utilization)),
    resetAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fiveHour = normalizeWindow(raw.five_hour);
  const sevenDay = normalizeWindow(raw.seven_day);
  if (!fiveHour && !sevenDay) return null;
  // Collapse to the more-pressing window, same as the statusline cache does.
  const top = [fiveHour, sevenDay].filter(Boolean).reduce((a, b) => (b.pct > a.pct ? b : a));
  return { pct: top.pct, resetAt: top.resetAt, fiveHour, sevenDay };
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
