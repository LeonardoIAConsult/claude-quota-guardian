const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { performCheck } = require('../../lib/threshold-check');
const paths = require('../../lib/paths');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function baseInput(cwd) {
  return {
    transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    cwd,
    session_id: 's1',
  };
}

test('performCheck throttles ccusage to once every planCheckIntervalToolCalls checks', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));

  let ccusageCalls = 0;
  t.mock.method(cp, 'execFileSync', () => {
    ccusageCalls += 1;
    return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 42 } }] });
  });

  const config = {
    plan: 'pro',
    planTokenLimit: null,
    planCheckIntervalToolCalls: 3,
    thresholds: { context: 0.995, plan: 0.995 },
  };
  const input = baseInput(cwd);

  performCheck(input, { config }); // no cache yet -> calls ccusage
  performCheck(input, { config }); // cached, under interval -> skip
  performCheck(input, { config }); // still under interval -> skip
  performCheck(input, { config }); // counter hits interval -> refresh

  assert.strictEqual(ccusageCalls, 2);

  const state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.strictEqual(state.planPct, 42);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('performCheck does not touch ccusage at all when plan is "none"', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));

  let ccusageCalls = 0;
  t.mock.method(cp, 'execFileSync', () => {
    ccusageCalls += 1;
    return '{}';
  });

  const config = {
    plan: 'none',
    planTokenLimit: null,
    planCheckIntervalToolCalls: 3,
    thresholds: { context: 0.995, plan: 0.995 },
  };
  const input = baseInput(cwd);

  performCheck(input, { config });
  performCheck(input, { config });

  assert.strictEqual(ccusageCalls, 0);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

function setupRelease(t, { ccusage, pending }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.CQG_HOME;
  });
  t.mock.method(cp, 'execFileSync', ccusage);
  const file = paths.pendingPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ consumed: false, checkpointFile: null, sessionId: 'old', ...pending }));
  const config = { plan: 'pro', planTokenLimit: null, planCheckIntervalToolCalls: 1, thresholds: { context: 0.995, plan: 0.95 } };
  return { cwd, config, readPending: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const ccusageAt = (pct) => () => JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: pct } }] });

test('performCheck releases an un-checkpointed quota pending once real quota is back under threshold', (t) => {
  const { cwd, config, readPending } = setupRelease(t, { ccusage: ccusageAt(42), pending: { triggeredBy: 'plan' } });

  assert.strictEqual(performCheck(baseInput(cwd), { config }), null);
  const p = readPending();
  assert.strictEqual(p.consumed, true);
  assert.strictEqual(p.consumedReason, 'below-threshold');
});

test('performCheck never releases a quota pending when there is no quota reading', (t) => {
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: () => { throw new Error('offline'); },
    pending: { triggeredBy: 'plan' },
  });

  performCheck(baseInput(cwd), { config });
  // context (50%) is measured and low, but it is not the signal that tripped the block
  assert.strictEqual(readPending().consumed, false);
});

test('performCheck leaves a checkpointed pending for SessionStart to resume', (t) => {
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: ccusageAt(42),
    pending: { triggeredBy: 'plan', checkpointFile: '/x/checkpoint.md' },
  });

  performCheck(baseInput(cwd), { config });
  assert.strictEqual(readPending().consumed, false);
});

test('performCheck keeps the pending while quota is still over threshold', (t) => {
  const { cwd, config, readPending } = setupRelease(t, { ccusage: ccusageAt(97), pending: { triggeredBy: 'plan' } });

  assert.ok(performCheck(baseInput(cwd), { config }));
  assert.strictEqual(readPending().consumed, false);
});

function contextReleaseCase(t, ownerSession) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.CQG_HOME;
  });
  const file = paths.pendingPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ consumed: false, checkpointFile: null, triggeredBy: 'context', sessionId: ownerSession }));
  // plan 'none' + no usageApi: context (50% in the fixture) is the only signal
  const config = { plan: 'none', blockOnContext: true, planCheckIntervalToolCalls: 1, thresholds: { context: 0.995, plan: 0.95 } };
  performCheck(baseInput(cwd), { config }); // baseInput runs as session 's1'
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('performCheck lets only the owning session release a context pending', (t) => {
  assert.strictEqual(contextReleaseCase(t, 's1').consumed, true);
});

test('performCheck does not let another session\'s low context release a context pending', (t) => {
  assert.strictEqual(contextReleaseCase(t, 'someone-else').consumed, false);
});

test('performCheck keeps a context pending while that session\'s context is still over threshold', (t) => {
  const { cwd, config, readPending } = setupRelease(t, { ccusage: ccusageAt(42), pending: { triggeredBy: 'context', sessionId: 's1' } });
  config.blockOnContext = true;
  // a plan reading exists (so context is demoted and anyAtThreshold is false),
  // but this session's own context is at 99.6% -- no release.
  performCheck({ ...baseInput(cwd), transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl') }, { config });
  assert.strictEqual(readPending().consumed, false);
});

test('performCheck records another over-threshold terminal session as an offender', (t) => {
  const { cwd, config, readPending } = setupRelease(t, { ccusage: ccusageAt(97), pending: { triggeredBy: 'plan', sessionId: 'closed-owner' } });

  performCheck(baseInput(cwd), { config }); // runs as 's1'
  const p = readPending();
  assert.strictEqual(p.sessionId, 'closed-owner');
  assert.deepStrictEqual(p.offenders, ['s1']);
  assert.strictEqual(p.consumed, false);
});

test('performCheck never records the owner itself as an offender', (t) => {
  const { cwd, config, readPending } = setupRelease(t, { ccusage: ccusageAt(97), pending: { triggeredBy: 'plan', sessionId: 's1' } });

  performCheck(baseInput(cwd), { config }); // the owner itself: nothing to add
  assert.strictEqual(readPending().offenders, undefined);
});

function contextPendingCase(t, pending, configExtra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.CQG_HOME;
  });
  const file = paths.pendingPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ consumed: false, checkpointFile: null, sessionId: 's1', ...pending }));
  const config = { plan: 'none', blockOnContext: true, planCheckIntervalToolCalls: 1, thresholds: { context: 0.995, plan: 0.95 }, ...configExtra };
  performCheck(baseInput(cwd), { config }); // fixture context: 50%
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('performCheck keeps a predictive context pending until context actually drops', (t) => {
  const p = contextPendingCase(t, { triggeredBy: 'context-predicted', pctAtTrigger: { context: 40, plan: null } });
  assert.strictEqual(p.consumed, false);
});

test('performCheck releases a predictive context pending once context is below its trigger level', (t) => {
  const p = contextPendingCase(t, { triggeredBy: 'context-predicted', pctAtTrigger: { context: 60, plan: null } });
  assert.strictEqual(p.consumed, true);
});

test('performCheck does not release a context pending when context blocking is off', (t) => {
  const p = contextPendingCase(t, { triggeredBy: 'context' }, { blockOnContext: false });
  assert.strictEqual(p.consumed, false);
});

test('performCheck drops a session from offenders once it is itself back under threshold', (t) => {
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: ccusageAt(42),
    // a context pending owned by another session: this session can't release it
    pending: { triggeredBy: 'context', sessionId: 'old', offenders: ['s1', 'x'] },
  });
  config.blockOnContext = true;

  performCheck(baseInput(cwd), { config });
  const p = readPending();
  assert.strictEqual(p.consumed, false);
  assert.deepStrictEqual(p.offenders, ['x']);
});

test('performCheck keeps an offender when there is no reading at all', (t) => {
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: () => { throw new Error('offline'); },
    pending: { triggeredBy: 'plan', sessionId: 'old', offenders: ['s1'] },
  });
  config.blockOnContext = false;

  performCheck(baseInput(cwd), { config });
  assert.deepStrictEqual(readPending().offenders, ['s1']);
});

test('performCheck never clobbers a checkpointFile stored while it was fetching usage', (t) => {
  let pendingFile;
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: () => {
      const p = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      fs.writeFileSync(pendingFile, JSON.stringify({ ...p, checkpointFile: '/saved/checkpoint.md' }));
      return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 42 } }] });
    },
    pending: { triggeredBy: 'plan', sessionId: 'old' },
  });
  pendingFile = paths.pendingPath(cwd);

  performCheck(baseInput(cwd), { config });
  const p = readPending();
  assert.strictEqual(p.checkpointFile, '/saved/checkpoint.md');
  assert.strictEqual(p.consumed, false); // checkpointed: left for SessionStart
});

test('performCheck never releases a context pending when context is unmeasured', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.CQG_HOME;
  });
  const file = paths.pendingPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ consumed: false, checkpointFile: null, triggeredBy: 'context', sessionId: 's1' }));
  const config = { plan: 'none', blockOnContext: true, planCheckIntervalToolCalls: 1, thresholds: { context: 0.995, plan: 0.95 } };

  performCheck({ ...baseInput(cwd), transcript_path: path.join(FIXTURES, 'transcript-cli-no-usage.jsonl') }, { config });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).consumed, false);
});

test('performCheck keeps an offender of a quota pending when only context is readable', (t) => {
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: () => { throw new Error('offline'); },
    pending: { triggeredBy: 'plan', sessionId: 'old', offenders: ['s1'] },
  });
  config.blockOnContext = true; // context (50%) is measured, but it is not the signal that tripped it

  performCheck(baseInput(cwd), { config });
  assert.deepStrictEqual(readPending().offenders, ['s1']);
});

test('performCheck never clobbers a checkpointFile stored during the fetch when recording an offender', (t) => {
  let pendingFile;
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: () => {
      const p = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      fs.writeFileSync(pendingFile, JSON.stringify({ ...p, checkpointFile: '/saved/checkpoint.md' }));
      return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 97 } }] });
    },
    pending: { triggeredBy: 'plan', sessionId: 'old', lastNotifiedAt: '2000-01-01T00:00:00Z' },
  });
  pendingFile = paths.pendingPath(cwd);

  performCheck(baseInput(cwd), { config });
  const p = readPending();
  assert.strictEqual(p.checkpointFile, '/saved/checkpoint.md');
  assert.deepStrictEqual(p.offenders, ['s1']);
  // a checkpoint landed: no "falta /continuity-checkpoint" re-notify stamp
  assert.strictEqual(p.lastNotifiedAt, '2000-01-01T00:00:00Z');
});

test('performCheck does not release a pending that was replaced during the fetch', (t) => {
  let pendingFile;
  const { cwd, config, readPending } = setupRelease(t, {
    ccusage: () => {
      fs.writeFileSync(pendingFile, JSON.stringify({
        consumed: false, checkpointFile: null, triggeredBy: 'plan', sessionId: 'newer', triggeredAt: '2099-01-01T00:00:00Z',
      }));
      return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 42 } }] });
    },
    pending: { triggeredBy: 'plan', sessionId: 'old', triggeredAt: '2026-01-01T00:00:00Z' },
  });
  pendingFile = paths.pendingPath(cwd);

  performCheck(baseInput(cwd), { config });
  const p = readPending();
  assert.strictEqual(p.sessionId, 'newer');
  assert.strictEqual(p.consumed, false);
});

test('performCheck does not re-notify when it cannot store the new lastNotifiedAt', (t) => {
  const notify = require('../../lib/notify');
  const { cwd, config } = setupRelease(t, {
    ccusage: ccusageAt(97),
    pending: { triggeredBy: 'plan', sessionId: 's1', lastNotifiedAt: '2000-01-01T00:00:00Z' },
  });
  // A directory at this process's tmp name makes every atomic write of
  // pending.json fail (exclusive create hits it, and it can't be rm'd as a file).
  const file = paths.pendingPath(cwd);
  fs.mkdirSync(path.join(path.dirname(file), `.pending.json.${process.pid}.tmp`));
  const sent = [];
  t.mock.method(notify, 'send', (...args) => { sent.push(args); });

  performCheck(baseInput(cwd), { config });
  performCheck(baseInput(cwd), { config });
  assert.strictEqual(sent.filter(([, msg]) => /falta \/continuity-checkpoint/.test(msg)).length, 0);
});
