const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notify = require('../../lib/notify');
const paths = require('../../lib/paths');
const { getStatus } = require('../../lib/usage-monitor');
const { computeDowngradeWarn, isHighTierModel, performCheck, RENOTIFY_INTERVAL_MS } = require('../../lib/threshold-check');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const CFG = { downgrade: { enabled: true, warnPct: 85, models: ['opus'] }, thresholds: { plan: 0.995 } };
const NOW = 10_000_000;

// --- isHighTierModel ---

test('isHighTierModel matches premium models by marker, ignores cheaper ones', () => {
  assert.strictEqual(isHighTierModel('claude-opus-4-8', ['opus']), true);
  assert.strictEqual(isHighTierModel('claude-sonnet-4-6', ['opus']), false);
  assert.strictEqual(isHighTierModel('claude-haiku-4-5', ['opus']), false);
  assert.strictEqual(isHighTierModel(null, ['opus']), false);
});

// --- computeDowngradeWarn (pure band + throttle logic) ---

test('computeDowngradeWarn fires inside the band on a premium model', (t) => {
  let sent = 0;
  t.mock.method(notify, 'send', () => { sent += 1; });
  const r = computeDowngradeWarn({
    config: CFG,
    status: { planPct: 90, model: 'claude-opus-4-8' },
    prevState: null,
    now: NOW,
  });
  assert.strictEqual(sent, 1);
  assert.strictEqual(r.lastDowngradeWarnAt, new Date(NOW).toISOString());
});

test('computeDowngradeWarn stays silent on a non-premium model', (t) => {
  let sent = 0;
  t.mock.method(notify, 'send', () => { sent += 1; });
  const r = computeDowngradeWarn({
    config: CFG,
    status: { planPct: 90, model: 'claude-sonnet-4-6' },
    prevState: null,
    now: NOW,
  });
  assert.strictEqual(sent, 0);
  assert.strictEqual(r.lastDowngradeWarnAt, null);
});

test('computeDowngradeWarn stays silent below warnPct and at/above the hard block', (t) => {
  t.mock.method(notify, 'send', () => { throw new Error('should not notify'); });
  const below = computeDowngradeWarn({ config: CFG, status: { planPct: 80, model: 'claude-opus-4-8' }, prevState: null, now: NOW });
  assert.strictEqual(below.lastDowngradeWarnAt, null);
  const above = computeDowngradeWarn({ config: CFG, status: { planPct: 99.6, model: 'claude-opus-4-8' }, prevState: null, now: NOW });
  assert.strictEqual(above.lastDowngradeWarnAt, null); // 99.6 >= hard 99.5 -> checkpoint block owns it
});

test('computeDowngradeWarn throttles re-notify within the interval', (t) => {
  let sent = 0;
  t.mock.method(notify, 'send', () => { sent += 1; });
  const recent = new Date(NOW - 1000).toISOString();
  const r = computeDowngradeWarn({
    config: CFG,
    status: { planPct: 90, model: 'claude-opus-4-8' },
    prevState: { lastDowngradeWarnAt: recent },
    now: NOW,
  });
  assert.strictEqual(sent, 0);
  assert.strictEqual(r.lastDowngradeWarnAt, recent); // unchanged: still within interval

  const r2 = computeDowngradeWarn({
    config: CFG,
    status: { planPct: 90, model: 'claude-opus-4-8' },
    prevState: { lastDowngradeWarnAt: new Date(NOW - RENOTIFY_INTERVAL_MS - 1).toISOString() },
    now: NOW,
  });
  assert.strictEqual(sent, 1); // interval elapsed -> fires again
});

test('computeDowngradeWarn is inert when disabled', (t) => {
  t.mock.method(notify, 'send', () => { throw new Error('should not notify'); });
  const r = computeDowngradeWarn({
    config: { downgrade: { enabled: false, warnPct: 85, models: ['opus'] }, thresholds: { plan: 0.995 } },
    status: { planPct: 90, model: 'claude-opus-4-8' },
    prevState: null,
    now: NOW,
  });
  assert.strictEqual(r.lastDowngradeWarnAt, null);
});

// --- model propagation ---

test('getStatus propagates the session model from the transcript', () => {
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-opus-low.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.996, plan: 0.995 } },
  });
  assert.strictEqual(status.model, 'claude-opus-4-8');
});

// --- performCheck end-to-end: warns without blocking, persists the timestamp ---

test('performCheck warns (no block) on a premium model in the quota band and records it', (t) => {
  t.mock.method(notify, 'send', () => {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-dg-'));
  const prevEnv = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.CQG_HOME; else process.env.CQG_HOME = prevEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cwd = 'C:\\fake\\downgrade';
  // Seed a cached account-quota signal inside the band (90% < hard 99.5%).
  const statePath = paths.statePath(cwd);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ rateLimitPct: 90, rateLimitResetAt: '2026-08-04T00:00:00.000Z' }));

  const config = {
    plan: 'none',
    thresholds: { context: 0.996, plan: 0.995, desktopWarn: 0.99 },
    downgrade: { enabled: true, warnPct: 85, models: ['opus'] },
    predictive: { enabled: true, leadSeconds: 90, minSamples: 3, maxSamples: 8, windowSeconds: 300 },
  };

  const reason = performCheck(
    { transcript_path: path.join(FIXTURES, 'transcript-opus-low.jsonl'), cwd, session_id: 's1' },
    { config }
  );

  // 90% plan is below the hard block -> no pending, no block, just a nudge.
  assert.strictEqual(reason, null);
  assert.strictEqual(fs.existsSync(paths.pendingPath(cwd)), false);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.model, 'claude-opus-4-8');
  assert.ok(state.lastDowngradeWarnAt, 'downgrade warn timestamp persisted for throttling');
  assert.strictEqual(state.rateLimitPct, 90); // cached signal carried forward
});
