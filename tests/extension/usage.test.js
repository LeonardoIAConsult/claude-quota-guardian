const test = require('node:test');
const assert = require('node:assert');

// extension/lib/usage.js attaches itself to globalThis, as it does in the
// popup and the service worker.
require('../../extension/lib/usage.js');
const U = globalThis.GuardianUsage;

// Outside the browser there is no chrome.i18n: the tests hand usage.js one
// language's messages.json. Spanish is the default for the whole file; the
// English tests switch language inside withLang() and always switch back.
const MESSAGES = {
  es: require('../../extension/_locales/es/messages.json'),
  en: require('../../extension/_locales/en/messages.json'),
};
U.setMessages(MESSAGES.es);

function withLang(lang, fn) {
  const back = () => U.setMessages(MESSAGES.es);
  U.setMessages(MESSAGES[lang]);
  let result;
  try {
    result = fn();
  } catch (e) {
    back();
    throw e;
  }
  if (result && typeof result.finally === 'function') return result.finally(back);
  back();
  return result;
}

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

test('badge is the plain % of the most-pressing window; the tooltip says which window it is', () => {
  const b = U.badgeFor(reading(), null, NOW);
  assert.strictEqual(b.text, '70%');
  assert.match(b.title, /el número es Semanal/);
  assert.match(b.title, /Semanal 70 %/);
  assert.match(b.title, /Sesión 2 %/);
  assert.match(b.title, /Fable 0 %/);
});

test('badge holds only digits and "%" (a letter prefix read as a digit: "S72" looked like "572")', () => {
  const r = reading();
  for (const [session, weekly] of [[85, 10], [2, 72], [100, 30], [130, 0]]) {
    r.blocking[0].pct = session;
    r.blocking[1].pct = weekly;
    const { text } = U.badgeFor(r, null, NOW);
    assert.match(text, /^\d{1,3}%$/, text);
    assert.ok(text.length <= 4, text);
  }
  r.blocking[0].pct = 130;
  assert.strictEqual(U.badgeFor(r, null, NOW).text, '100%');
});

test('a window whose reset passed does not drive the badge with its old %', () => {
  const r = reading();
  r.blocking[1].pct = 95;
  r.blocking[1].resetAt = new Date(NOW - 60000).toISOString();
  const b = U.badgeFor(r, null, NOW);
  assert.strictEqual(b.text, '2%');
  assert.match(b.title, /el número es Sesión/);
  assert.match(b.title, /Semanal: reiniciada/);
  assert.ok(!b.title.includes('95'));
});

test('a failed refresh keeps the last good number, grey, and says why in the tooltip', () => {
  const b = U.badgeFor(reading(), 'http-429', NOW);
  assert.strictEqual(b.text, '70%');
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

test('es and en messages.json have exactly the same keys and the same placeholders', () => {
  const keys = (m) => Object.keys(m).sort();
  assert.deepStrictEqual(keys(MESSAGES.en), keys(MESSAGES.es));
  for (const k of keys(MESSAGES.es)) {
    assert.deepStrictEqual(
      Object.keys(MESSAGES.en[k].placeholders || {}).sort(),
      Object.keys(MESSAGES.es[k].placeholders || {}).sort(),
      k,
    );
    assert.ok(MESSAGES.en[k].message && MESSAGES.es[k].message, k);
  }
});

test('English: windows are named 5h window / Weekly, and a credit says Cloud credit', async () => {
  const usage = {
    limits: [
      { kind: 'session', percent: 2, resets_at: '2026-10-23T01:00:00Z', scope: null },
      { kind: 'weekly_all', percent: 70, resets_at: '2026-10-24T18:00:00Z', scope: null },
    ],
    iguana_necktie: { limit_dollars: 10, used_dollars: 4, remaining_dollars: 6 },
    other_credit: { limit_dollars: 5, used_dollars: 1, remaining_dollars: 4 },
  };
  await withLang('en', async () => {
    const u = await withFetch([
      ['/usage', response(200, usage)],
      ['/api/organizations', response(200, [{ uuid: 'org-1', capabilities: ['chat'] }])],
    ], () => U.fetchUsage());
    assert.deepStrictEqual(u.blocking.map((w) => [w.label, w.pct]), [['5h window', 2], ['Weekly', 70]]);
    assert.deepStrictEqual(u.credits.map((c) => c.label), ['Cloud credit', 'Promo credit']);
  });
});

test('English: the badge is still only digits and "%"; the tooltip says which window it is', () => {
  withLang('en', () => {
    const r = reading();
    r.blocking[0].label = '5h window';
    r.blocking[1].label = 'Weekly';
    const b = U.badgeFor(r, null, NOW);
    assert.strictEqual(b.text, '70%');
    assert.match(b.title, /badge shows Weekly/);
    assert.match(b.title, /Weekly 70% \(resets in 2 d\)/);
    assert.match(b.title, /5h window 2% \(resets in 5 h 0 min\)/);
    assert.match(b.title, /Fable 0%/);
    assert.match(b.title, /updated \d\d:\d\d/);

    for (const [session, weekly] of [[85, 10], [2, 72], [100, 30], [130, 0]]) {
      r.blocking[0].pct = session;
      r.blocking[1].pct = weekly;
      assert.match(U.badgeFor(r, null, NOW).text, /^\d{1,3}%$/);
    }
  });
});

test('English: rolled-over windows and failed refreshes say so in the tooltip', () => {
  withLang('en', () => {
    const r = reading();
    r.blocking[1].pct = 95;
    r.blocking[1].resetAt = new Date(NOW - 60000).toISOString();
    r.blocking[1].label = 'Weekly';
    const rolled = U.badgeFor(r, null, NOW);
    assert.strictEqual(rolled.text, '2%');
    assert.match(rolled.title, /Weekly: reset, refreshing…/);
    assert.ok(!rolled.title.includes('95'));

    const stale = U.badgeFor(reading(), 'http-429', NOW);
    assert.strictEqual(stale.color, '#6b6b6b');
    assert.match(stale.title, /not updated: Claude returned an error \(429\)\./);

    const none = U.badgeFor(null, 'not-logged-in', NOW);
    assert.strictEqual(none.text, '!');
    assert.match(none.title, /Sign in to claude\.ai/);
  });
});

test('English: every reason has its own text and fmtLeft speaks English', () => {
  withLang('en', () => {
    for (const reason of ['not-logged-in', 'network', 'no-org', 'no-windows', 'bad-json', 'worker-error', 'http-503', 'zzz', undefined]) {
      assert.ok(U.reasonText(reason).length > 0, String(reason));
      assert.ok(!/[ñ¿¡]|sesión|Claude no/i.test(U.reasonText(reason)), U.reasonText(reason));
    }
    assert.strictEqual(U.reasonText('http-503'), 'Claude returned an error (503).');
    assert.strictEqual(U.fmtLeft(new Date(NOW - 1000).toISOString(), NOW), 'reset');
    assert.strictEqual(U.fmtLeft(new Date(NOW + 30 * 60000).toISOString(), NOW), 'resets in 30 min');
  });
  assert.strictEqual(U.fmtLeft(new Date(NOW + 30 * 60000).toISOString(), NOW), 'reinicia en 30 min');
});
