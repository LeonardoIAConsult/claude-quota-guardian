const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const cp = require('node:child_process');
const { getContextUsage, getPlanUsage, getStatus, getEntrypoint } = require('../../lib/usage-monitor');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

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

test('getStatus reports "both" when context and plan both hit', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: 'reset-time', tokenLimitStatus: { percentUsed: 99.7 } }],
  }));

  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    config: { plan: 'pro', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'both');
  assert.strictEqual(status.planResetAt, 'reset-time');
});
