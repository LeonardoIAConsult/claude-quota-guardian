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

test('runWatcherOnce returns zero when continuityRoot does not exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-watcher-'));
  process.env.CQG_HOME = home;

  const summary = watcher.runWatcherOnce({ now: new Date(), config: { notifications: { enabled: true } } });
  assert.deepStrictEqual(summary, { checked: 0, notified: 0 });

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});
