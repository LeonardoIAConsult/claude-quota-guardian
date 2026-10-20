const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const clock = require('../../lib/cache-clock');

const NOW = Date.parse('2026-10-19T20:00:00Z');
const MIN = 60000;

test('ttl: a pinned ttlMinutes wins over the estimate', () => {
  assert.strictEqual(clock.resolveTtlMinutes({ ttlMinutes: 15 }, { hasRateLimits: true }), 15);
  assert.strictEqual(clock.resolveTtlMinutes({ ttlMinutes: 15 }, { hasRateLimits: false }), 15);
});

test('ttl: estimate is 60 min on a subscription and 5 min on an API key', () => {
  assert.strictEqual(clock.resolveTtlMinutes({ ttlMinutes: null }, { hasRateLimits: true }), 60);
  assert.strictEqual(clock.resolveTtlMinutes({ ttlMinutes: null }, { hasRateLimits: false }), 5);
  assert.strictEqual(clock.resolveTtlMinutes(undefined, {}), 5);
});

test('ttl: zero, negative or non-numeric ttlMinutes falls back to the estimate', () => {
  assert.strictEqual(clock.resolveTtlMinutes({ ttlMinutes: 0 }, { hasRateLimits: true }), 60);
  assert.strictEqual(clock.resolveTtlMinutes({ ttlMinutes: -3 }, { hasRateLimits: true }), 60);
  assert.strictEqual(clock.resolveTtlMinutes({ ttlMinutes: '30' }, { hasRateLimits: true }), 60);
});

test('warn minutes: default 5, a configured 0 is honoured', () => {
  assert.strictEqual(clock.resolveWarnMinutes({}), 5);
  assert.strictEqual(clock.resolveWarnMinutes({ warnMinutes: 0 }), 0);
  assert.strictEqual(clock.resolveWarnMinutes({ warnMinutes: 10 }), 10);
});

test('status: null before any activity', () => {
  assert.strictEqual(clock.cacheStatus({ lastMs: null, ttlMinutes: 60, now: NOW }), null);
  assert.strictEqual(clock.cacheStatus({ lastMs: NaN, ttlMinutes: 60, now: NOW }), null);
});

test('status: fresh activity shows the full ttl, not ttl+1', () => {
  assert.deepStrictEqual(clock.cacheStatus({ lastMs: NOW, ttlMinutes: 60, now: NOW }), { minutesLeft: 60, expired: false, warn: false });
});

test('status: rounds up, warns at the threshold, expires at the ttl', () => {
  assert.deepStrictEqual(clock.cacheStatus({ lastMs: NOW - 54.5 * MIN, ttlMinutes: 60, now: NOW }), { minutesLeft: 6, expired: false, warn: false });
  assert.deepStrictEqual(clock.cacheStatus({ lastMs: NOW - 55 * MIN, ttlMinutes: 60, now: NOW }), { minutesLeft: 5, expired: false, warn: true });
  assert.deepStrictEqual(clock.cacheStatus({ lastMs: NOW - 59.9 * MIN, ttlMinutes: 60, now: NOW }), { minutesLeft: 1, expired: false, warn: true });
  assert.deepStrictEqual(clock.cacheStatus({ lastMs: NOW - 60 * MIN, ttlMinutes: 60, now: NOW }), { minutesLeft: 0, expired: true, warn: true });
  assert.deepStrictEqual(clock.cacheStatus({ lastMs: NOW - 90 * MIN, ttlMinutes: 60, now: NOW }), { minutesLeft: 0, expired: true, warn: true });
});

test('status: a timestamp in the future (clock skew) never exceeds the ttl', () => {
  assert.strictEqual(clock.cacheStatus({ lastMs: NOW + 10 * MIN, ttlMinutes: 5, now: NOW }).minutesLeft, 5);
});

test('lastActivityMs reads the transcript mtime and is null when missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-clock-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '{}\n');
  const when = new Date(NOW - 7 * MIN);
  fs.utimesSync(file, when, when);

  assert.strictEqual(Math.round(clock.lastActivityMs(file) / 1000), Math.round(when.getTime() / 1000));
  assert.strictEqual(clock.lastActivityMs(path.join(dir, 'missing.jsonl')), null);
  assert.strictEqual(clock.lastActivityMs(null), null);

  fs.rmSync(dir, { recursive: true, force: true });
});
