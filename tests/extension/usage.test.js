const test = require('node:test');
const assert = require('node:assert');

// extension/lib/usage.js attaches itself to globalThis, as it does in the
// popup and the service worker.
require('../../extension/lib/usage.js');
const U = globalThis.GuardianUsage;

const NOW = Date.parse('2026-10-22T20:00:00Z');
const H = 3600000;

function reading(over = {}) {
  const blocking = [
    { kind: 'session', label: 'Sesión', pct: 2, resetAt: new Date(NOW + 5 * H).toISOString(), blocking: true },
    { kind: 'weekly_all', label: 'Semanal', pct: 70, resetAt: new Date(NOW + 46 * H).toISOString(), blocking: true },
  ];
  const scoped = [{ kind: 'weekly_scoped', label: 'Fable', pct: 0, resetAt: null, blocking: false }];
  return { ok: true, blocking, scoped, windows: [...blocking, ...scoped], fetchedAt: NOW - 60000, ...over };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function withFetch(routes, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    for (const [part, res] of routes) if (url.includes(part)) return typeof res === 'function' ? res() : res;
    throw new Error(`unexpected ${url}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

test('badge says which window the number is, and the tooltip carries every window', () => {
  const b = U.badgeFor(reading(), null, NOW);
  assert.strictEqual(b.text, 'S70');
  assert.match(b.title, /Semanal 70 %/);
  assert.match(b.title, /Sesión 2 %/);
  assert.match(b.title, /Fable 0 %/);
  assert.ok(b.text.length <= 4);
});

test('badge for the 5-hour window is prefixed 5h and fits in 4 characters at 100 %', () => {
  const r = reading();
  r.blocking[0].pct = 85;
  r.blocking[1].pct = 10;
  assert.strictEqual(U.badgeFor(r, null, NOW).text, '5h85');
  r.blocking[0].pct = 100;
  assert.strictEqual(U.badgeFor(r, null, NOW).text, '5h!');
});

test('a window whose reset passed does not drive the badge with its old %', () => {
  const r = reading();
  r.blocking[1].pct = 95;
  r.blocking[1].resetAt = new Date(NOW - 60000).toISOString();
  const b = U.badgeFor(r, null, NOW);
  assert.strictEqual(b.text, '5h2');
  assert.match(b.title, /Semanal: reiniciada/);
  assert.ok(!b.title.includes('95'));
});

test('a failed refresh keeps the last good number, grey, and says why in the tooltip', () => {
  const b = U.badgeFor(reading(), 'http-429', NOW);
  assert.strictEqual(b.text, 'S70');
  assert.strictEqual(b.color, '#6b6b6b');
  assert.match(b.title, /sin actualizar/);
  assert.match(b.title, /429/);
});

test('with no reading ever, a failure shows "!" instead of an empty badge', () => {
  const b = U.badgeFor(null, 'not-logged-in', NOW);
  assert.strictEqual(b.text, '!');
  assert.match(b.title, /Inicia sesión/);
  assert.strictEqual(U.badgeFor(null, null, NOW).text, '');
});

test('a 429 on the organizations list is Claude failing, not "inicia sesión"', async () => {
  const u = await withFetch([['/api/organizations', response(429, null)]], () => U.fetchUsage());
  assert.deepStrictEqual(u, { ok: false, reason: 'http-429' });
  assert.match(U.reasonText(u.reason), /429/);
});

test('401 on the organizations list means signed out', async () => {
  const u = await withFetch([['/api/organizations', response(401, null)]], () => U.fetchUsage());
  assert.deepStrictEqual(u, { ok: false, reason: 'not-logged-in' });
});

test('fetchUsage reads limits[] and names the window that drives the badge', async () => {
  const usage = {
    limits: [
      { kind: 'session', percent: 2, resets_at: '2026-10-23T01:00:00Z', scope: null },
      { kind: 'weekly_all', percent: 70, resets_at: '2026-10-24T18:00:00Z', scope: null },
      { kind: 'weekly_scoped', percent: 0, resets_at: '2026-10-24T18:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
    ],
  };
  const u = await withFetch([
    ['/usage', response(200, usage)],
    ['/api/organizations', response(200, [{ uuid: 'org-1', capabilities: ['chat'] }])],
  ], () => U.fetchUsage());
  assert.strictEqual(u.ok, true);
  assert.strictEqual(u.topPct, 70);
  assert.strictEqual(u.topKind, 'weekly_all');
  assert.deepStrictEqual(u.blocking.map((w) => [w.label, w.pct]), [['Sesión', 2], ['Semanal', 70]]);
  assert.deepStrictEqual(u.scoped.map((w) => [w.label, w.pct]), [['Fable', 0]]);
});

test('every request carries a time limit so a hung claude.ai cannot freeze the popup', async () => {
  const signals = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    signals.push(opts && opts.signal);
    return url.includes('/usage') ? response(200, { limits: [{ kind: 'session', percent: 1, scope: null }] })
      : response(200, [{ uuid: 'o', capabilities: ['chat'] }]);
  };
  try {
    await U.fetchUsage();
  } finally {
    globalThis.fetch = saved;
  }
  assert.strictEqual(signals.length, 2);
  assert.ok(signals.every((s) => s && typeof s.aborted === 'boolean'));
});
