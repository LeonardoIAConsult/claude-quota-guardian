const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { getContextUsage, getPlanUsage, getThrottledPlanUsage, getStatus, getEntrypoint } = require('../../lib/usage-monitor');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

// Isolates readAccessToken from the machine's real ~/.claude/.credentials.json
// for tests that exercise the usage-API path with an empty cache.
function withEmptyHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-monitor-'));
  const prev = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CQG_HOME;
    else process.env.CQG_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

test('getContextUsage computes pct from latest assistant usage', () => {
  const result = getContextUsage(path.join(FIXTURES, 'transcript-50pct.jsonl'));
  assert.strictEqual(result.pct, 50);
  assert.strictEqual(result.used, 90000);
  assert.strictEqual(result.limit, 180000);
  assert.strictEqual(result.model, 'claude-sonnet-4-6');
});

test('getContextUsage detects near-threshold usage', () => {
  const result = getContextUsage(path.join(FIXTURES, 'transcript-99-6pct.jsonl'));
  assert.ok(Math.abs(result.pct - 99.6) < 0.001);
});

test('getContextUsage returns null pct when no usage found', () => {
  const result = getContextUsage(path.join(FIXTURES, 'transcript-no-usage.jsonl'));
  assert.strictEqual(result.pct, null);
  assert.strictEqual(result.error, 'no-usage-found');
});

test('getContextUsage returns null pct for missing file', () => {
  const result = getContextUsage(path.join(FIXTURES, 'does-not-exist.jsonl'));
  assert.strictEqual(result.pct, null);
  assert.strictEqual(result.error, 'transcript-unreadable');
});

test('getPlanUsage returns unavailable for plan "none"', () => {
  const result = getPlanUsage('none');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'plan-none');
});

test('getPlanUsage parses ccusage active block', (t) => {
  const fakeOutput = JSON.stringify({
    blocks: [
      {
        endTime: '2026-06-11T18:00:00Z',
        tokenLimitStatus: { percentUsed: 87.2 },
      },
    ],
  });
  t.mock.method(cp, 'execFileSync', () => fakeOutput);

  const result = getPlanUsage('pro');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 87.2);
  assert.strictEqual(result.resetAt, '2026-06-11T18:00:00Z');
});

test('getPlanUsage returns unavailable when ccusage throws', (t) => {
  t.mock.method(cp, 'execFileSync', () => {
    throw new Error('not found');
  });

  const result = getPlanUsage('pro');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'ccusage-unavailable');
});

test('getPlanUsage returns unavailable when ccusage output has no limit data', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({ blocks: [{ endTime: 'x' }] }));

  const result = getPlanUsage('pro');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'no-limit-data');
  assert.strictEqual(result.resetAt, 'x');
});

test('getPlanUsage computes pct from totalTokens when planTokenLimit is set (ccusage >=20)', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: '2026-06-14T08:00:00Z', totalTokens: 9_000_000 }],
  }));

  const result = getPlanUsage('pro', 10_000_000);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 90);
  assert.strictEqual(result.resetAt, '2026-06-14T08:00:00Z');
});

test('getPlanUsage stays unavailable for ccusage >=20 format without planTokenLimit', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: 'reset', totalTokens: 9_000_000 }],
  }));

  const result = getPlanUsage('pro');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'no-limit-data');
});

test('getStatus flags context threshold hit when plan is "none"', () => {
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'context');
  assert.strictEqual(status.planPct, null);
});

test('getStatus does not block on context when blockOnContext is false', () => {
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    config: { plan: 'none', blockOnContext: false, thresholds: { context: 0.995, plan: 0.995 } },
  });
  // context is over threshold but demoted -- still measured, never a trigger
  assert.strictEqual(status.anyAtThreshold, false);
  assert.strictEqual(status.triggeredBy, null);
  assert.ok(Math.abs(status.contextPct - 99.6) < 0.001);
});

test('getStatus reports no threshold hit below limits', () => {
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, false);
  assert.strictEqual(status.triggeredBy, null);
});

test('getEntrypoint reads "cli" from a CLI transcript', () => {
  const result = getEntrypoint(path.join(FIXTURES, 'transcript-50pct.jsonl'));
  assert.strictEqual(result, 'cli');
});

test('getEntrypoint reads "claude-desktop" from a Desktop transcript', () => {
  const result = getEntrypoint(path.join(FIXTURES, 'transcript-99-2pct-desktop.jsonl'));
  assert.strictEqual(result, 'claude-desktop');
});

test('getEntrypoint returns null when no entrypoint field is present', () => {
  const result = getEntrypoint(path.join(FIXTURES, 'transcript-no-usage.jsonl'));
  assert.strictEqual(result, null);
});

test('getEntrypoint returns null for missing file', () => {
  const result = getEntrypoint(path.join(FIXTURES, 'does-not-exist.jsonl'));
  assert.strictEqual(result, null);
});

test('getStatus uses cachedRateLimit as plan% when plan is "none" (no ccusage needed)', () => {
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } },
    cachedRateLimit: { pct: 99.7, resetAt: '2026-06-20T00:00:00.000Z' },
  });
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'plan');
  assert.strictEqual(status.planPct, 99.7);
  assert.strictEqual(status.planResetAt, '2026-06-20T00:00:00.000Z');
});

test('getStatus prefers cachedRateLimit over ccusage plan% only when it is higher', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: 'ccusage-reset', tokenLimitStatus: { percentUsed: 40 } }],
  }));

  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'pro', thresholds: { context: 0.995, plan: 0.995 } },
    cachedRateLimit: { pct: 99.8, resetAt: 'rate-limit-reset' },
  });
  assert.strictEqual(status.planPct, 99.8);
  assert.strictEqual(status.planResetAt, 'rate-limit-reset');
});

test('getStatus ignores cachedRateLimit when lower than ccusage plan%', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: 'ccusage-reset', tokenLimitStatus: { percentUsed: 99.9 } }],
  }));

  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'pro', thresholds: { context: 0.995, plan: 0.995 } },
    cachedRateLimit: { pct: 10, resetAt: 'rate-limit-reset' },
  });
  assert.strictEqual(status.planPct, 99.9);
  assert.strictEqual(status.planResetAt, 'ccusage-reset');
});

test('getThrottledPlanUsage calls ccusage when there is no cached reading yet', (t) => {
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => {
    calls += 1;
    return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 55 } }] });
  });

  const result = getThrottledPlanUsage({ planType: 'pro', intervalToolCalls: 5, counter: 1, cachedPlan: null });
  assert.strictEqual(calls, 1);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 55);
  assert.strictEqual(result.due, true);
});

test('getThrottledPlanUsage skips ccusage and reuses cachedPlan while under the interval', (t) => {
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => {
    calls += 1;
    return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 99 } }] });
  });

  const cachedPlan = { available: true, pct: 30, resetAt: 'old-reset' };
  const result = getThrottledPlanUsage({ planType: 'pro', intervalToolCalls: 5, counter: 3, cachedPlan });

  assert.strictEqual(calls, 0);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 30);
  assert.strictEqual(result.resetAt, 'old-reset');
  assert.strictEqual(result.due, false);
});

test('getThrottledPlanUsage refreshes via ccusage once counter reaches the interval', (t) => {
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => {
    calls += 1;
    return JSON.stringify({ blocks: [{ endTime: 'fresh-reset', tokenLimitStatus: { percentUsed: 77 } }] });
  });

  const cachedPlan = { available: true, pct: 30, resetAt: 'old-reset' };
  const result = getThrottledPlanUsage({ planType: 'pro', intervalToolCalls: 5, counter: 5, cachedPlan });

  assert.strictEqual(calls, 1);
  assert.strictEqual(result.pct, 77);
  assert.strictEqual(result.resetAt, 'fresh-reset');
  assert.strictEqual(result.due, true);
});

test('getThrottledPlanUsage falls back to cachedPlan when a due ccusage call fails', (t) => {
  t.mock.method(cp, 'execFileSync', () => {
    throw new Error('not found');
  });

  const cachedPlan = { available: true, pct: 30, resetAt: 'old-reset' };
  const result = getThrottledPlanUsage({ planType: 'pro', intervalToolCalls: 5, counter: 5, cachedPlan });

  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 30);
  assert.strictEqual(result.due, true);
});

test('getThrottledPlanUsage returns unavailable for plan "none" without touching ccusage', (t) => {
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => { calls += 1; return '{}'; });

  const result = getThrottledPlanUsage({ planType: 'none', intervalToolCalls: 5, counter: 99, cachedPlan: null });
  assert.strictEqual(calls, 0);
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.due, false);
});

test('getStatus takes plan% from a fresh usage-API cache and skips ccusage entirely', (t) => {
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => { calls += 1; return '{}'; });

  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'pro', usageApi: { enabled: true, cacheSeconds: 60 }, thresholds: { context: 0.995, plan: 0.995 } },
    cachedApiUsage: {
      pct: 99.7,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
      fetchedAt: new Date().toISOString(),
    },
  });

  assert.strictEqual(calls, 0);
  assert.strictEqual(status.planPct, 99.7);
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'plan');
  assert.strictEqual(status.apiUsage.available, true);
  assert.strictEqual(status.planUsage.reason, 'api-active');
});

test('getStatus never touches the usage API unless config enables it explicitly', () => {
  // No cp mock and no CQG_HOME override: a network attempt would be a real
  // spawn, so reaching this assertion proves the disabled gate held.
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } },
    cachedApiUsage: { pct: 99.9, resetAt: null, fetchedAt: new Date().toISOString() },
  });
  assert.strictEqual(status.apiUsage.available, false);
  assert.strictEqual(status.apiUsage.reason, 'disabled');
  assert.strictEqual(status.planPct, null);
});

test('getStatus still lets a higher cachedRateLimit win over the usage API', (t) => {
  t.mock.method(cp, 'execFileSync', () => '{}');

  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'none', usageApi: { enabled: true, cacheSeconds: 60 }, thresholds: { context: 0.995, plan: 0.995 } },
    cachedRateLimit: { pct: 90, resetAt: 'statusline-reset' },
    cachedApiUsage: {
      pct: 40,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
      fetchedAt: new Date().toISOString(),
    },
  });

  assert.strictEqual(status.planPct, 90);
  assert.strictEqual(status.planResetAt, 'statusline-reset');
});

test('getStatus falls back to ccusage when the usage API has no credentials', (t) => {
  withEmptyHome(t);
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: 'cc-reset', tokenLimitStatus: { percentUsed: 62 } }],
  }));

  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: {
      plan: 'pro',
      usageApi: { enabled: true, cacheSeconds: 60 },
      thresholds: { context: 0.995, plan: 0.995 },
      planCheckIntervalToolCalls: 1,
    },
    planCheckCounter: 1,
  });

  assert.strictEqual(status.apiUsage.available, false);
  assert.strictEqual(status.apiUsage.reason, 'no-credentials');
  assert.strictEqual(status.planPct, 62);
  assert.strictEqual(status.planResetAt, 'cc-reset');
});

test('getStatus lets the real plan quota own the block (context demoted to fallback)', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: 'reset-time', tokenLimitStatus: { percentUsed: 99.7 } }],
  }));

  // Both context (99.6% of the fixture) and plan (99.7%) are over threshold, but
  // with a real plan-quota signal present the context estimate is a fallback and
  // must not co-drive the block: the trigger is 'plan', never 'both'.
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    config: { plan: 'pro', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'plan');
  assert.strictEqual(status.planResetAt, 'reset-time');
});

test('context fallback still blocks when NO real plan signal exists', () => {
  // plan 'none' + no usageApi/rate_limit => context is the only signal, so it
  // must still hard-block (protects API-key users with no quota endpoint).
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'context');
});
