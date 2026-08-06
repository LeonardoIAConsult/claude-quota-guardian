const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { projectContext } = require('../../lib/usage-monitor');
const paths = require('../../lib/paths');
const notify = require('../../lib/notify');
const { performCheck } = require('../../lib/threshold-check');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const PRED = { enabled: true, leadSeconds: 90, minSamples: 3, maxSamples: 8, windowSeconds: 300 };
const CFG = { predictive: PRED, thresholds: { context: 0.996 } };
const NOW = 1_000_000;

// --- projectContext: pure slope/projection logic ---

test('projectContext fires early when the slope will cross the threshold within leadSeconds', () => {
  const samples = [{ pct: 30, ts: NOW - 2000 }, { pct: 40, ts: NOW - 1000 }];
  const r = projectContext({ samples, now: NOW, contextPct: 50, config: CFG });
  assert.strictEqual(r.hit, true);
  assert.ok(r.projectedPct >= 99.6, `projected ${r.projectedPct} should clear the threshold`);
  assert.strictEqual(r.samples.length, 3); // current reading appended
});

test('projectContext does not fire on a flat (non-rising) slope', () => {
  const samples = [{ pct: 50, ts: NOW - 2000 }, { pct: 50, ts: NOW - 1000 }];
  const r = projectContext({ samples, now: NOW, contextPct: 50, config: CFG });
  assert.strictEqual(r.hit, false);
});

test('projectContext stays quiet until it has minSamples readings', () => {
  const samples = [{ pct: 40, ts: NOW - 1000 }];
  const r = projectContext({ samples, now: NOW, contextPct: 50, config: CFG });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.samples.length, 2); // accumulating toward minSamples
});

test('projectContext never double-fires once the current reading is already at the threshold', () => {
  const samples = [{ pct: 99.5, ts: NOW - 2000 }, { pct: 99.6, ts: NOW - 1000 }];
  const r = projectContext({ samples, now: NOW, contextPct: 99.7, config: CFG });
  assert.strictEqual(r.hit, false); // a real contextHit owns this case, not the predictor
});

test('projectContext is inert when predictive is disabled, and passes samples through', () => {
  const samples = [{ pct: 30, ts: NOW - 2000 }, { pct: 40, ts: NOW - 1000 }];
  const r = projectContext({ samples, now: NOW, contextPct: 50, config: { predictive: { ...PRED, enabled: false }, thresholds: { context: 0.996 } } });
  assert.strictEqual(r.hit, false);
  assert.deepStrictEqual(r.samples, samples);
});

test('projectContext drops samples older than the window before fitting', () => {
  const samples = [
    { pct: 10, ts: NOW - 10 * 60 * 1000 }, // 10 min old -> outside 300s window, dropped
    { pct: 40, ts: NOW - 2000 },
    { pct: 45, ts: NOW - 1000 },
  ];
  const r = projectContext({ samples, now: NOW, contextPct: 50, config: CFG });
  assert.strictEqual(r.samples.length, 3); // stale one dropped, current appended
  assert.ok(r.samples.every((s) => NOW - s.ts <= PRED.windowSeconds * 1000));
});

// --- performCheck: predictive trigger wired end-to-end (in-process, no hook spawn) ---

test('performCheck blocks predictively before the wall from a steep rising slope', (t) => {
  t.mock.method(notify, 'send', () => {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-pred-'));
  const prevEnv = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.CQG_HOME; else process.env.CQG_HOME = prevEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cwd = 'C:\\fake\\predict';
  // Seed a steep climb in state.json so THIS check's reading (50% from the
  // fixture) projects past 99.6% within leadSeconds.
  const statePath = paths.statePath(cwd);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const t0 = Date.now();
  fs.writeFileSync(statePath, JSON.stringify({
    predictSamples: [{ pct: 30, ts: t0 - 2000 }, { pct: 40, ts: t0 - 1000 }],
  }));

  const config = {
    plan: 'none',
    thresholds: { context: 0.996, plan: 0.995, desktopWarn: 0.99 },
    predictive: PRED,
    planCheckIntervalToolCalls: 5,
  };

  const reason = performCheck(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd, session_id: 's1' },
    { config }
  );

  assert.match(reason, /continuity-checkpoint/);

  const pending = JSON.parse(fs.readFileSync(paths.pendingPath(cwd), 'utf8'));
  assert.strictEqual(pending.consumed, false);
  assert.strictEqual(pending.triggeredBy, 'context-predicted');

  // state.json carries the ring buffer forward for the next check.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(Array.isArray(state.predictSamples) && state.predictSamples.length >= 3);
});

test('performCheck stays silent on a flat slope below threshold (no false early block)', (t) => {
  t.mock.method(notify, 'send', () => {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-pred-'));
  const prevEnv = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.CQG_HOME; else process.env.CQG_HOME = prevEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cwd = 'C:\\fake\\predict-flat';
  const statePath = paths.statePath(cwd);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const t0 = Date.now();
  fs.writeFileSync(statePath, JSON.stringify({
    predictSamples: [{ pct: 50, ts: t0 - 2000 }, { pct: 50, ts: t0 - 1000 }],
  }));

  const config = {
    plan: 'none',
    thresholds: { context: 0.996, plan: 0.995, desktopWarn: 0.99 },
    predictive: PRED,
    planCheckIntervalToolCalls: 5,
  };

  const reason = performCheck(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd, session_id: 's1' },
    { config }
  );

  assert.strictEqual(reason, null);
  assert.strictEqual(fs.existsSync(paths.pendingPath(cwd)), false);
});
