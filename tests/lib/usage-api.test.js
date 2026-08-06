const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const usageApi = require('../../lib/usage-api');

// Points CQG_HOME at a throwaway home dir so readAccessToken never sees the
// machine's real ~/.claude/.credentials.json. Pass creds === null for a home
// with no credentials file at all.
function withHome(t, creds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-usage-api-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (creds !== null) {
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds));
  }
  const prev = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CQG_HOME;
    else process.env.CQG_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function validCreds() {
  return { claudeAiOauth: { accessToken: 'sk-ant-oat01-test', expiresAt: Date.now() + 3600_000 } };
}

function apiResponse(fivePct, sevenPct) {
  return JSON.stringify({
    data: {
      five_hour: { utilization: fivePct, resets_at: '2026-08-03T22:00:00Z' },
      seven_day: { utilization: sevenPct, resets_at: '2026-08-08T18:00:00Z' },
    },
  });
}

test('readAccessToken returns the token from valid credentials', (t) => {
  withHome(t, validCreds());
  assert.strictEqual(usageApi.readAccessToken(), 'sk-ant-oat01-test');
});

test('readAccessToken returns null when the credentials file is missing', (t) => {
  withHome(t, null);
  assert.strictEqual(usageApi.readAccessToken(), null);
});

test('readAccessToken returns null for an expired token', (t) => {
  withHome(t, { claudeAiOauth: { accessToken: 'sk-ant-oat01-old', expiresAt: Date.now() - 1000 } });
  assert.strictEqual(usageApi.readAccessToken(), null);
});

test('fetchUsage is unavailable without credentials and never spawns', (t) => {
  withHome(t, null);
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => { calls += 1; return '{}'; });

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'no-credentials');
  assert.strictEqual(calls, 0);
});

test('fetchUsage collapses to the more-pressing window', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => apiResponse(12, 80));

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 80);
  assert.strictEqual(result.resetAt, '2026-08-08T18:00:00Z');
  assert.strictEqual(result.fiveHour.pct, 12);
  assert.strictEqual(result.sevenDay.pct, 80);
  assert.ok(result.fetchedAt);
});

test('fetchUsage parses limits[] into blocking + scoped windows', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    data: {
      five_hour: { utilization: 11, resets_at: '2026-08-06T22:00:00Z' },
      seven_day: { utilization: 68, resets_at: '2026-08-08T18:00:00Z' },
      limits: [
        { kind: 'session', percent: 11, resets_at: '2026-08-06T22:00:00Z', scope: null },
        { kind: 'weekly_all', percent: 68, resets_at: '2026-08-08T18:00:00Z', scope: null },
        { kind: 'weekly_scoped', percent: 37, resets_at: '2026-08-08T18:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    },
  }));

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, true);
  // block signal = max of session + weekly_all only (Fable excluded)
  assert.strictEqual(result.pct, 68);
  assert.strictEqual(result.topWindow.kind, 'weekly_all');
  assert.strictEqual(result.windows.length, 3);
  assert.strictEqual(result.scoped.length, 1);
  assert.strictEqual(result.scoped[0].label, 'Fable');
  assert.strictEqual(result.scoped[0].pct, 37);
  assert.strictEqual(result.scoped[0].blocking, false);
});

test('fetchUsage block signal ignores a maxed scoped model', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    data: {
      limits: [
        { kind: 'session', percent: 20, resets_at: 'r1', scope: null },
        { kind: 'weekly_all', percent: 40, resets_at: 'r2', scope: null },
        { kind: 'weekly_scoped', percent: 100, resets_at: 'r3', scope: { model: { display_name: 'Fable' } } },
      ],
    },
  }));

  const result = usageApi.fetchUsage();
  // Fable at 100% must NOT drive the block -- only session/weekly do.
  assert.strictEqual(result.pct, 40);
  assert.strictEqual(result.topWindow.kind, 'weekly_all');
});

test('fetchUsage session (5h) drives the block when it is the hottest', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    data: {
      limits: [
        { kind: 'session', percent: 99, resets_at: 'r1', scope: null },
        { kind: 'weekly_all', percent: 40, resets_at: 'r2', scope: null },
      ],
    },
  }));

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.pct, 99);
  assert.strictEqual(result.topWindow.kind, 'session');
});

test('fetchUsage treats an unknown account-wide window (no scope) as blocking', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    data: {
      limits: [
        { kind: 'weekly_all', percent: 30, resets_at: 'r1', scope: null },
        // a future account-wide window Anthropic might add, with no scope:
        { kind: 'monthly_all', percent: 96, resets_at: 'r2', scope: null },
        // surface-scoped cap must stay advisory (does not gate the CLI turn):
        { kind: 'weekly_scoped', percent: 100, resets_at: 'r3', scope: { surface: { display_name: 'Cowork' } } },
      ],
    },
  }));

  const result = usageApi.fetchUsage();
  // unknown-but-account-wide (96) drives the block; surface-scoped 100 ignored
  assert.strictEqual(result.pct, 96);
  assert.strictEqual(result.topWindow.kind, 'monthly_all');
  assert.strictEqual(result.scoped.length, 1);
  assert.strictEqual(result.scoped[0].label, 'Cowork');
  assert.strictEqual(result.scoped[0].blocking, false);
});

test('fetchUsage never passes the token through argv', (t) => {
  withHome(t, validCreds());
  let seenArgs = null;
  let seenOpts = null;
  t.mock.method(cp, 'execFileSync', (_file, args, opts) => {
    seenArgs = args;
    seenOpts = opts;
    return apiResponse(1, 2);
  });

  usageApi.fetchUsage();
  assert.ok(!JSON.stringify(seenArgs).includes('sk-ant-oat01-test'));
  assert.ok(seenOpts.input.includes('sk-ant-oat01-test'));
});

test('fetchUsage surfaces HTTP errors as unavailable', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({ error: 'http-401' }));

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'http-401');
});

test('fetchUsage is unavailable when the child fails', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => { throw new Error('spawn failed'); });

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'fetch-failed');
});

test('fetchUsage is unavailable on unparseable child output', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => 'not-json');

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'bad-output');
});

test('fetchUsage is unavailable when the response has no usage windows', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({ data: { spend: {} } }));

  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'no-usage-windows');
});

test('getThrottledUsage reuses a fresh cache without spawning', (t) => {
  withHome(t, validCreds());
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => { calls += 1; return apiResponse(50, 50); });

  const nowMs = Date.now();
  const cachedApi = {
    pct: 33,
    resetAt: new Date(nowMs + 3600_000).toISOString(),
    fetchedAt: new Date(nowMs - 10_000).toISOString(),
  };
  const result = usageApi.getThrottledUsage({ cacheSeconds: 60, cachedApi, nowMs });

  assert.strictEqual(calls, 0);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 33);
  assert.strictEqual(result.due, false);
});

test('getThrottledUsage refetches once the cache ages out', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => apiResponse(10, 77));

  const nowMs = Date.now();
  const cachedApi = {
    pct: 33,
    resetAt: new Date(nowMs + 3600_000).toISOString(),
    fetchedAt: new Date(nowMs - 120_000).toISOString(),
  };
  const result = usageApi.getThrottledUsage({ cacheSeconds: 60, cachedApi, nowMs });

  assert.strictEqual(result.pct, 77);
  assert.strictEqual(result.due, true);
});

test('getThrottledUsage force-refreshes a fresh-by-age cache whose window rolled over', (t) => {
  withHome(t, validCreds());
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => { calls += 1; return apiResponse(1, 2); });

  const nowMs = Date.now();
  const cachedApi = {
    pct: 99,
    resetAt: new Date(nowMs - 1000).toISOString(), // reset already passed
    fetchedAt: new Date(nowMs - 5_000).toISOString(), // but cache is only 5s old
  };
  const result = usageApi.getThrottledUsage({ cacheSeconds: 60, cachedApi, nowMs });

  assert.strictEqual(calls, 1);
  assert.strictEqual(result.pct, 2);
});

test('getThrottledUsage keeps the stale reading when a due refresh fails', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => { throw new Error('offline'); });

  const nowMs = Date.now();
  const cachedApi = {
    pct: 88,
    resetAt: new Date(nowMs + 3600_000).toISOString(),
    fetchedAt: new Date(nowMs - 120_000).toISOString(),
  };
  const result = usageApi.getThrottledUsage({ cacheSeconds: 60, cachedApi, nowMs });

  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 88);
  assert.strictEqual(result.due, true);
});

test('getThrottledUsage drops a stale reading whose window rolled over', (t) => {
  withHome(t, validCreds());
  t.mock.method(cp, 'execFileSync', () => { throw new Error('offline'); });

  const nowMs = Date.now();
  const cachedApi = {
    pct: 99,
    resetAt: new Date(nowMs - 1000).toISOString(),
    fetchedAt: new Date(nowMs - 120_000).toISOString(),
  };
  const result = usageApi.getThrottledUsage({ cacheSeconds: 60, cachedApi, nowMs });

  assert.strictEqual(result.available, false);
});
