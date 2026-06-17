const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'check-usage.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

function pendingFileFor(home, cwd) {
  return path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd), 'pending.json');
}

function stateFileFor(home, cwd) {
  return path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd), 'state.json');
}

function runHook(input, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('check-usage no-ops below threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );
  assert.strictEqual(out.trim(), '');
  assert.strictEqual(fs.existsSync(pendingFileFor(home, 'C:\\fake\\project')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage writes a heartbeat state.json below threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  const state = JSON.parse(fs.readFileSync(stateFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.ok(typeof state.maxPct === 'number');
  assert.ok(state.maxPct > 0 && state.maxPct < 90);
  assert.strictEqual(state.sessionId, 's1');
  assert.ok(state.updatedAt);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage writes pending.json and blocks at threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');
  assert.match(decision.reason, /continuity-checkpoint/);

  const pending = JSON.parse(fs.readFileSync(pendingFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(pending.consumed, false);
  assert.strictEqual(pending.triggeredBy, 'context');
  assert.strictEqual(pending.checkpointFile, null);
  assert.ok(pending.pctAtTrigger.context >= 99.5);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage does not overwrite an existing pending with a new trigger', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const pendingFile = pendingFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify({
    consumed: false,
    triggeredAt: '2020-01-01T00:00:00.000Z',
    pctAtTrigger: { context: 99.5, plan: null },
    lastNotifiedAt: new Date().toISOString(), // just notified -> suppress re-notify this run
  }));

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  // Still re-emits the block decision every call -- this is the fix: a soft
  // block must not go silent forever after the first (easily-missed) toast.
  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');

  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.triggeredAt, '2020-01-01T00:00:00.000Z'); // original trigger preserved

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage keeps writing the heartbeat even while a pending checkpoint is outstanding', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const pendingFile = pendingFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify({ consumed: false, pctAtTrigger: { context: 99.5, plan: null } }));

  runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  // This is the core fix: previously the idempotency guard returned before
  // ever touching state.json, so the watcher's adaptive polling starved
  // after the first trigger. Now the heartbeat keeps flowing regardless.
  const state = JSON.parse(fs.readFileSync(stateFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.ok(state.maxPct >= 99.5);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage warns but never blocks or pends for claude-desktop, even above the CLI hard-block threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-7pct-desktop.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  // Desktop has no "end the turn now" affordance like a terminal -- it's
  // notify-only, never a hard block, even past the CLI's 99.6% threshold.
  assert.strictEqual(out.trim(), '');
  assert.strictEqual(fs.existsSync(pendingFileFor(home, 'C:\\fake\\project')), false);

  const state = JSON.parse(fs.readFileSync(stateFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(state.entrypoint, 'claude-desktop');
  assert.ok(state.lastDesktopWarnAt);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage desktop warn threshold (99%) is independent of and lower than the CLI hard-block threshold (99.6%)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));

  runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-2pct-desktop.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  // 99.2% is below the CLI's 99.6% threshold but above Desktop's 99% warn
  // threshold -- the warn marker firing here proves the lower threshold is
  // actually live for this entrypoint, not just inherited from the CLI path.
  const state = JSON.parse(fs.readFileSync(stateFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.ok(state.lastDesktopWarnAt);
  assert.strictEqual(fs.existsSync(pendingFileFor(home, 'C:\\fake\\project')), false);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage hard-blocks on CLI from a cached rate_limit signal alone, even with low local context', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  // hooks/statusline.js caches rate_limits here on its own cadence -- seed it
  // directly to simulate that having already happened before this hook runs.
  const statePath = stateFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ rateLimitPct: 99.8, rateLimitResetAt: '2026-06-20T00:00:00.000Z' }));

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');

  const pending = JSON.parse(fs.readFileSync(pendingFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(pending.triggeredBy, 'plan');
  assert.strictEqual(pending.pctAtTrigger.plan, 99.8);

  // The heartbeat rewrite must carry the cached rate-limit fields forward
  // instead of clobbering them -- they're only ever refreshed by statusline.js.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.rateLimitPct, 99.8);
  assert.strictEqual(state.rateLimitResetAt, '2026-06-20T00:00:00.000Z');

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage warns about account-wide plan quota on claude-desktop, driven by a cached rate_limit signal alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));

  const statePath = stateFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ rateLimitPct: 99.9, rateLimitResetAt: '2026-06-20T00:00:00.000Z' }));

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct-desktop.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  assert.strictEqual(out.trim(), '');
  assert.strictEqual(fs.existsSync(pendingFileFor(home, 'C:\\fake\\project')), false);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // Local context is only ~50% here -- lastDesktopWarnAt (context warn) must
  // stay unset while lastDesktopPlanWarnAt (account-quota warn) fires, proving
  // the two Desktop warnings are independently triggered.
  assert.strictEqual(state.lastDesktopWarnAt, null);
  assert.ok(state.lastDesktopPlanWarnAt);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage exits 0 with bad stdin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});
