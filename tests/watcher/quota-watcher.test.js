const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteFileSync } = require('../../lib/atomic-write');
const watcher = require('../../watcher/quota-watcher');

function makePendingDir(home, hash) {
  const dir = path.join(home, '.claude', 'session-continuity', hash);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'pending.json');
}

test('shouldNotifyReset returns false when resetNotified already true', () => {
  const pending = {
    triggeredBy: 'plan',
    planResetAtSeen: new Date(Date.now() - 1000).toISOString(),
    resetNotified: true,
  };
  assert.strictEqual(watcher.shouldNotifyReset(pending, new Date()), false);
});

test('shouldNotifyReset returns false for context-only triggers', () => {
  const pending = {
    triggeredBy: 'context',
    planResetAtSeen: null,
    resetNotified: false,
  };
  assert.strictEqual(watcher.shouldNotifyReset(pending, new Date()), false);
});

test('shouldNotifyReset returns false before reset time', () => {
  const pending = {
    triggeredBy: 'plan',
    planResetAtSeen: new Date(Date.now() + 60_000).toISOString(),
    resetNotified: false,
  };
  assert.strictEqual(watcher.shouldNotifyReset(pending, new Date()), false);
});

test('shouldNotifyReset returns true once reset time has passed', () => {
  const pending = {
    triggeredBy: 'both',
    planResetAtSeen: new Date(Date.now() - 60_000).toISOString(),
    resetNotified: false,
  };
  assert.strictEqual(watcher.shouldNotifyReset(pending, new Date()), true);
});

test('processPendingFile notifies and sets resetNotified on reset', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  const pendingFile = makePendingDir(home, 'hash1');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    projectPath: 'C:\\fake\\project',
    projectName: 'project',
    triggeredBy: 'plan',
    planResetAtSeen: new Date(Date.now() - 1000).toISOString(),
    resetNotified: false,
  }, null, 2));

  const calls = [];
  const result = watcher.processPendingFile(pendingFile, {
    now: new Date(),
    notifySend: (title, message) => calls.push({ title, message }),
  });

  assert.strictEqual(result.notified, true);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].message, /project/);

  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.resetNotified, true);

  fs.rmSync(home, { recursive: true, force: true });
});

test('processPendingFile is anti-spam: second run does not notify again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  const pendingFile = makePendingDir(home, 'hash2');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    projectPath: 'C:\\fake\\project',
    projectName: 'project',
    triggeredBy: 'plan',
    planResetAtSeen: new Date(Date.now() - 1000).toISOString(),
    resetNotified: false,
  }, null, 2));

  const calls = [];
  const notifySend = (title, message) => calls.push({ title, message });

  watcher.processPendingFile(pendingFile, { now: new Date(), notifySend });
  watcher.processPendingFile(pendingFile, { now: new Date(), notifySend });

  assert.strictEqual(calls.length, 1);

  fs.rmSync(home, { recursive: true, force: true });
});

test('runWatcherOnce checks every project dir under continuityRoot', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  process.env.CQG_HOME = home;

  makePendingDir(home, 'hashA');
  const pendingFile1 = path.join(home, '.claude', 'session-continuity', 'hashA', 'pending.json');
  atomicWriteFileSync(pendingFile1, JSON.stringify({
    projectPath: 'C:\\fake\\a',
    projectName: 'a',
    triggeredBy: 'plan',
    planResetAtSeen: new Date(Date.now() - 1000).toISOString(),
    resetNotified: false,
  }, null, 2));

  makePendingDir(home, 'hashB');
  const pendingFile2 = path.join(home, '.claude', 'session-continuity', 'hashB', 'pending.json');
  atomicWriteFileSync(pendingFile2, JSON.stringify({
    projectPath: 'C:\\fake\\b',
    projectName: 'b',
    triggeredBy: 'context',
    planResetAtSeen: null,
    resetNotified: false,
  }, null, 2));

  const calls = [];
  const config = { notifications: { enabled: true } };
  const summary = watcher.runWatcherOnce({
    now: new Date(),
    config,
    notifySend: (title, message) => calls.push({ title, message }),
  });

  assert.strictEqual(summary.checked, 2);
  assert.strictEqual(summary.notified, 1);
  assert.strictEqual(calls.length, 1);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('runWatcherOnce respects notifications.enabled=false', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  process.env.CQG_HOME = home;

  makePendingDir(home, 'hashC');
  const pendingFile = path.join(home, '.claude', 'session-continuity', 'hashC', 'pending.json');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    projectPath: 'C:\\fake\\c',
    projectName: 'c',
    triggeredBy: 'plan',
    planResetAtSeen: new Date(Date.now() - 1000).toISOString(),
    resetNotified: false,
  }, null, 2));

  const calls = [];
  const config = { notifications: { enabled: false } };
  const summary = watcher.runWatcherOnce({
    now: new Date(),
    config,
    notifySend: (title, message) => calls.push({ title, message }),
  });

  assert.strictEqual(summary.checked, 1);
  assert.strictEqual(summary.notified, 0);
  assert.strictEqual(calls.length, 0);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

function writeState(home, hash, state) {
  const dir = path.join(home, '.claude', 'session-continuity', hash);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}

const ADAPTIVE_CFG = {
  watcherIntervalMinutes: 15,
  adaptiveWatcher: { enabled: true, baseMinutes: 15, tiers: [{ atPct: 90, minutes: 3 }, { atPct: 98, minutes: 1 }] },
};

test('readLiveMaxPct returns highest fresh maxPct across projects', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  process.env.CQG_HOME = home;
  const root = path.join(home, '.claude', 'session-continuity');

  const now = new Date();
  writeState(home, 'p1', { maxPct: 72.5, updatedAt: now.toISOString() });
  writeState(home, 'p2', { maxPct: 94.1, updatedAt: now.toISOString() });

  assert.strictEqual(watcher.readLiveMaxPct(root, { now }), 94.1);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('readLiveMaxPct ignores stale heartbeats', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  const root = path.join(home, '.claude', 'session-continuity');
  const now = new Date();

  writeState(home, 'p1', { maxPct: 99, updatedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() });
  writeState(home, 'p2', { maxPct: 40, updatedAt: now.toISOString() });

  assert.strictEqual(watcher.readLiveMaxPct(root, { now, stalenessMs: 20 * 60 * 1000 }), 40);

  fs.rmSync(home, { recursive: true, force: true });
});

test('reconcileInterval reschedules when tier changes and persists state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  process.env.CQG_HOME = home;
  const now = new Date();

  const calls = [];
  const result = watcher.reconcileInterval({
    now,
    config: ADAPTIVE_CFG,
    readMaxPct: () => 98,
    getCurrentInterval: () => 15,
    applyReschedule: (mins) => calls.push(mins),
  });

  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.to, 1);
  assert.deepStrictEqual(calls, [1]);

  const persisted = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'session-continuity', 'watcher-state.json'), 'utf8'));
  assert.strictEqual(persisted.intervalMinutes, 1);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('reconcileInterval is a no-op when interval already matches', () => {
  const calls = [];
  const result = watcher.reconcileInterval({
    config: ADAPTIVE_CFG,
    readMaxPct: () => 50,
    getCurrentInterval: () => 15,
    applyReschedule: (mins) => calls.push(mins),
  });

  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.intervalMinutes, 15);
  assert.strictEqual(calls.length, 0);
});

test('reconcileInterval is disabled when adaptiveWatcher.enabled is false', () => {
  const calls = [];
  const result = watcher.reconcileInterval({
    config: { adaptiveWatcher: { enabled: false } },
    readMaxPct: () => 99,
    getCurrentInterval: () => 15,
    applyReschedule: (mins) => calls.push(mins),
  });

  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.reason, 'disabled');
  assert.strictEqual(calls.length, 0);
});

test('runWatcherOnce returns zero when continuityRoot does not exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  process.env.CQG_HOME = home;

  const summary = watcher.runWatcherOnce({ now: new Date(), config: { notifications: { enabled: true } } });
  assert.deepStrictEqual(summary, { checked: 0, notified: 0 });

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('pollProviders writes codex session state and notifies over warnPct with throttle', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-codexhome-'));
  process.env.CQG_HOME = home;
  process.env.CQG_CODEX_HOME = codexHome;

  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const sessionsDir = path.join(codexHome, 'sessions', y, m, d);
  fs.mkdirSync(sessionsDir, { recursive: true });

  const rollout = path.join(sessionsDir, 'rollout-now.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's9', cwd: 'C:\proj\demo' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 95 }, model_context_window: 100 }, rate_limits: null } }),
  ].join('\n') + '\n');

  const config = {
    notifications: { enabled: true },
    providers: { codex: { enabled: true, warnPct: 90, stalenessMinutes: 20, renotifyMinutes: 15 } },
  };

  const sent = [];
  const first = watcher.pollProviders({ now, config, notifySend: (t, msg) => sent.push(msg) });
  assert.strictEqual(first.sessions, 1);
  assert.strictEqual(first.notified, 1);
  assert.match(sent[0], /95%/);
  assert.match(sent[0], /demo/);

  // Same poll again within renotifyMinutes: state refreshed, no second toast.
  const second = watcher.pollProviders({ now, config, notifySend: (t, msg) => sent.push(msg) });
  assert.strictEqual(second.notified, 0);
  assert.strictEqual(sent.length, 1);

  // State lands in the shared shape the adaptive cadence reads.
  const root = path.join(home, '.claude', 'session-continuity');
  const dirs = fs.readdirSync(root).filter((n) => n.startsWith('codex-'));
  assert.strictEqual(dirs.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(root, dirs[0], 'state.json'), 'utf8'));
  assert.strictEqual(state.maxPct, 95);
  assert.strictEqual(state.provider, 'codex');
  assert.ok(state.updatedAt);
  assert.ok(state.lastWarnedAt);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
  delete process.env.CQG_HOME;
  delete process.env.CQG_CODEX_HOME;
});

test('pollProviders is a no-op when the codex provider is disabled', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  process.env.CQG_HOME = home;

  const result = watcher.pollProviders({
    config: { notifications: { enabled: true }, providers: { codex: { enabled: false } } },
    notifySend: () => { throw new Error('must not notify'); },
  });
  assert.deepStrictEqual(result, { sessions: 0, notified: 0 });

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('pollProviders respects notifications.enabled=false but still writes state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-codexhome-'));
  process.env.CQG_HOME = home;
  process.env.CQG_CODEX_HOME = codexHome;

  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const sessionsDir = path.join(codexHome, 'sessions', y, m, d);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'rollout-q.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\p' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 99 }, model_context_window: 100 }, rate_limits: null } }),
  ].join('\n') + '\n');

  const sent = [];
  const result = watcher.pollProviders({
    now,
    config: { notifications: { enabled: false }, providers: { codex: { enabled: true, warnPct: 90 } } },
    notifySend: (t, msg) => sent.push(msg),
  });

  assert.strictEqual(result.sessions, 1);
  assert.strictEqual(sent.length, 0);
  const root = path.join(home, '.claude', 'session-continuity');
  assert.strictEqual(fs.readdirSync(root).filter((n) => n.startsWith('codex-')).length, 1);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
  delete process.env.CQG_HOME;
  delete process.env.CQG_CODEX_HOME;
});
