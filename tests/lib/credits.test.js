const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');

const usageApi = require('../../lib/usage-api');
const { renderCredits, describe, main } = require('../../scripts/credits');

// Shape of the real 2026-09 response: the cloud promo credit under an internal
// codename, plus neighbours that carry dollar fields set to null (must be ignored).
function rawWithCredit(key = 'iguana_necktie') {
  return {
    five_hour: { utilization: 30, resets_at: '2026-09-28T01:10:00Z', limit_dollars: null, used_dollars: null, remaining_dollars: null },
    seven_day: { utilization: 29, resets_at: '2026-10-03T18:00:00Z', limit_dollars: null, used_dollars: null, remaining_dollars: null },
    [key]: { utilization: 3.99, resets_at: '2026-11-05T07:59:00Z', limit_dollars: 250, used_dollars: 9.98, remaining_dollars: 240.02 },
    nimbus_quill: { utilization: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
    limits: [
      { kind: 'session', percent: 30, resets_at: '2026-09-28T01:10:00Z', scope: null },
      { kind: 'weekly_all', percent: 29, resets_at: '2026-10-03T18:00:00Z', scope: null },
    ],
  };
}

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-credits-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-test', expiresAt: Date.now() + 3600_000 },
  }));
  const prev = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CQG_HOME;
    else process.env.CQG_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

function loadExtensionUsage() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'lib', 'usage.js'), 'utf8');
  const sandbox = { self: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.self.GuardianUsage;
}

test('creditsFrom finds the cloud credit and ignores null-dollar windows', () => {
  const credits = usageApi.creditsFrom(rawWithCredit());
  assert.strictEqual(credits.length, 1);
  const c = credits[0];
  assert.strictEqual(c.label, 'Crédito nube');
  assert.strictEqual(c.limit, 250);
  assert.strictEqual(c.used, 9.98);
  assert.strictEqual(c.remaining, 240.02);
  assert.strictEqual(c.expiresAt, '2026-11-05T07:59:00Z');
  assert.ok(Math.abs(c.pct - 3.992) < 0.01);
});

test('creditsFrom recognizes a renamed credit by shape, with a generic label', () => {
  const credits = usageApi.creditsFrom(rawWithCredit('some_new_codename'));
  assert.strictEqual(credits.length, 1);
  assert.strictEqual(credits[0].label, 'Crédito promocional');
  assert.strictEqual(credits[0].key, 'some_new_codename');
});

test('creditsFrom derives the missing side and rejects a zero or bad limit', () => {
  const onlyRemaining = usageApi.creditsFrom({ x: { limit_dollars: 100, remaining_dollars: 40 } });
  assert.strictEqual(onlyRemaining[0].used, 60);
  assert.strictEqual(onlyRemaining[0].pct, 60);
  assert.deepStrictEqual(usageApi.creditsFrom({ x: { limit_dollars: 0, used_dollars: 1 } }), []);
  assert.deepStrictEqual(usageApi.creditsFrom({ x: { limit_dollars: '250', used_dollars: 1 } }), []);
  assert.deepStrictEqual(usageApi.creditsFrom({ x: { limit_dollars: 250 } }), []);
  assert.deepStrictEqual(usageApi.creditsFrom(null), []);
});

test('fetchUsage carries credits but they never drive the block signal', (t) => {
  withHome(t);
  const raw = rawWithCredit();
  raw.iguana_necktie.used_dollars = 249;
  raw.iguana_necktie.remaining_dollars = 1;
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({ data: raw }));
  const result = usageApi.fetchUsage();
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 30); // plan windows only, not the 99.6% credit
  assert.strictEqual(result.credits.length, 1);
  assert.strictEqual(result.credits[0].remaining, 1);
});

test('extension creditsFrom matches the CLI on the same response', () => {
  const ext = loadExtensionUsage();
  const cases = [
    rawWithCredit(),
    rawWithCredit('renamed'),
    { x: { limit_dollars: 100, remaining_dollars: 40 } },
    { x: { limit_dollars: 100, remaining_dollars: 130 } }, // remaining > limit -> used clamps to 0
    { x: { limit_dollars: 100, used_dollars: 130 } }, // used > limit -> remaining clamps to 0, pct to 100
    { constructor: { limit_dollars: 5, used_dollars: 1 } }, // prototype key -> generic label
    {},
  ];
  for (const raw of cases) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ext.creditsFrom(raw))), usageApi.creditsFrom(raw));
  }
});

test('creditsFrom clamps out-of-range amounts and never borrows a prototype label', () => {
  const [over] = usageApi.creditsFrom({ x: { limit_dollars: 100, used_dollars: 130 } });
  assert.strictEqual(over.remaining, 0);
  assert.strictEqual(over.pct, 100);
  const [under] = usageApi.creditsFrom({ x: { limit_dollars: 100, remaining_dollars: 130 } });
  assert.strictEqual(under.used, 0);
  const [proto] = usageApi.creditsFrom({ constructor: { limit_dollars: 5, used_dollars: 1 } });
  assert.strictEqual(proto.label, 'Crédito promocional');
});

function writeShared(obj) {
  const file = require('../../lib/paths').apiUsageCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

test('a stored reading from before credits keeps credits unknown, not empty', (t) => {
  withHome(t);
  t.mock.method(cp, 'execFileSync', () => { throw new Error('must not fetch'); });
  const nowMs = Date.now();
  writeShared({ reading: { pct: 40, fetchedAt: new Date(nowMs - 1000).toISOString(), resetAt: new Date(nowMs + 3600_000).toISOString() } });
  const result = usageApi.getThrottledUsage({ cacheSeconds: 60, cachedApi: null, nowMs });
  assert.strictEqual(result.credits, undefined);
  const out = describe(result, nowMs);
  assert.strictEqual(out.ok, false);
  assert.match(out.text, /anterior a los créditos/);
});

test('a stored reading drops malformed credit entries and keeps valid ones', (t) => {
  withHome(t);
  t.mock.method(cp, 'execFileSync', () => { throw new Error('must not fetch'); });
  const nowMs = Date.now();
  const good = { key: 'k', label: 'Crédito nube', limit: 250, used: 10, remaining: 240, pct: 4, expiresAt: null };
  writeShared({ reading: {
    pct: 40, fetchedAt: new Date(nowMs - 1000).toISOString(), resetAt: new Date(nowMs + 3600_000).toISOString(),
    credits: [null, { ...good, pct: 'x' }, { ...good, limit: null }, good],
  } });
  const result = usageApi.getThrottledUsage({ cacheSeconds: 60, cachedApi: null, nowMs });
  assert.deepStrictEqual(result.credits, [good]);
});

test('the credits command honors the anti-429 backoff: serves the stored reading, sends nothing', (t) => {
  withHome(t);
  let calls = 0;
  t.mock.method(cp, 'execFileSync', () => { calls += 1; throw new Error('must not fetch'); });
  const nowMs = Date.now();
  const good = { key: 'iguana_necktie', label: 'Crédito nube', limit: 250, used: 11.24, remaining: 238.76, pct: 4.5, expiresAt: '2026-11-05T07:59:00Z' };
  // Reading 4 minutes old (past the 60s cache) while a 429 backoff is active.
  writeShared({
    reading: { pct: 30, fetchedAt: new Date(nowMs - 240_000).toISOString(), resetAt: new Date(nowMs + 3600_000).toISOString(), credits: [good] },
    failures: 2, backoffUntil: nowMs + 120_000, lastError: 'http-429',
  });
  // Runs the command's real entry point (main -> readUsage), not a re-wiring of it.
  let printed = '';
  const code = main({ argv: [], stdout: { write: (s) => { printed += s; } }, stderr: { write: (s) => { printed += s; } } });
  assert.strictEqual(calls, 0);
  assert.strictEqual(code, 0);
  assert.match(printed, /quedan USD 238\.76/);
  assert.match(printed, /lectura de hace 4 min/);
});

test('describe reports an unavailable reading and an empty credit list distinctly', () => {
  assert.deepStrictEqual(describe({ available: false, reason: 'http-429' }).ok, false);
  assert.match(describe({ available: false, reason: 'http-429' }).text, /http-429/);
  const nowMs = Date.now();
  const none = describe({ available: true, credits: [], fetchedAt: new Date(nowMs - 30_000).toISOString() }, nowMs);
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.text, 'Sin créditos en dólares en tu cuenta.\n'); // fresh: no age note
});

test('renderCredits prints used, limit, remaining and days to expiry', () => {
  const credits = usageApi.creditsFrom(rawWithCredit());
  const out = renderCredits(credits, Date.parse('2026-09-28T00:00:00Z'));
  assert.match(out, /Crédito nube: USD 9\.98 usados de USD 250\.00 · quedan USD 240\.02 \(4%\)/);
  assert.match(out, /vence 2026-11-05 \(en 39 d\)/);
  assert.strictEqual(renderCredits([]), 'Sin créditos en dólares en tu cuenta.\n');
});
