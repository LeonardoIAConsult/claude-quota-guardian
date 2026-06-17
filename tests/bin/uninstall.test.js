const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../../bin/install');
const uninstall = require('../../bin/uninstall');
const paths = require('../../lib/paths');

const REPO_ROOT = path.join(__dirname, '..', '..');

test('uninstallHooks removes only the hooks installHooks added', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  fs.writeFileSync(settingsFilePath, JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.js' }] }] },
  }));

  install.installHooks({ settingsFilePath, repoRoot: REPO_ROOT });
  const result = uninstall.uninstallHooks({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.deepStrictEqual(result.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.js' }] },
  ]);
  assert.strictEqual(result.hooks.SessionStart, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallHooks is a no-op when settings.json does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  const result = uninstall.uninstallHooks({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.deepStrictEqual(result, {});
  assert.strictEqual(fs.existsSync(settingsFilePath), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallStatusLine removes a statusLine claimed by installStatusLine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  install.installStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });
  const result = uninstall.uninstallStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.strictEqual(result.removed, true);
  const onDisk = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
  assert.strictEqual(onDisk.statusLine, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallStatusLine leaves a statusLine owned by something else untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  const settingsFilePath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFilePath, JSON.stringify({
    statusLine: { type: 'command', command: 'powershell -File caveman-statusline.ps1' },
  }));

  const result = uninstall.uninstallStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.strictEqual(result.removed, false);
  const onDisk = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
  assert.strictEqual(onDisk.statusLine.command, 'powershell -File caveman-statusline.ps1');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallStatusLine is a no-op when settings.json does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  const result = uninstall.uninstallStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.strictEqual(result.removed, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallCommand removes continuity-checkpoint.md when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  const commandsDirPath = path.join(dir, 'commands');

  install.installCommand({ repoRoot: REPO_ROOT, commandsDirPath });
  const removed = uninstall.uninstallCommand({ commandsDirPath });

  assert.strictEqual(removed, path.join(commandsDirPath, 'continuity-checkpoint.md'));
  assert.strictEqual(fs.existsSync(removed), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallCommand returns null when nothing to remove', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  const commandsDirPath = path.join(dir, 'commands');
  fs.mkdirSync(commandsDirPath, { recursive: true });

  assert.strictEqual(uninstall.uninstallCommand({ commandsDirPath }), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallSchedule removes files written by installSchedule', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  process.env.CQG_HOME = home;

  install.installSchedule({ platform: 'linux', repoRoot: REPO_ROOT, execFn: () => {} });
  const result = uninstall.uninstallSchedule({ platform: 'linux', execFn: () => {} });

  assert.strictEqual(result.success, true);
  assert.strictEqual(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'cqg-watcher.service')), false);
  assert.strictEqual(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'cqg-watcher.timer')), false);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('uninstallSchedule returns success:false with fallback when execFn throws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  process.env.CQG_HOME = home;

  const result = uninstall.uninstallSchedule({
    platform: 'linux',
    execFn: () => { throw new Error('systemctl not found'); },
  });

  assert.strictEqual(result.success, false);
  assert.match(result.error, /systemctl not found/);
  assert.match(result.fallback.removeCronMatching, /cqg-watcher/);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('purgeData removes the continuity root directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  process.env.CQG_HOME = home;

  fs.mkdirSync(paths.continuityRoot(), { recursive: true });
  fs.writeFileSync(path.join(paths.continuityRoot(), 'config.json'), '{}');

  const purged = uninstall.purgeData();

  assert.strictEqual(purged, paths.continuityRoot());
  assert.strictEqual(fs.existsSync(purged), false);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('run orchestrates hooks, command, schedule and optional purge', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-uninstall-'));
  process.env.CQG_HOME = home;

  install.run({ repoRoot: REPO_ROOT, platform: 'linux', execFn: () => {}, log: () => {} });

  const logs = [];
  const result = uninstall.run({
    repoRoot: REPO_ROOT,
    platform: 'linux',
    execFn: () => {},
    purge: true,
    log: (msg) => logs.push(msg),
  });

  assert.strictEqual(result.settings.hooks, undefined);
  assert.strictEqual(result.statusLine.removed, true);
  assert.strictEqual(result.schedule.success, true);
  assert.strictEqual(result.purged, paths.continuityRoot());
  assert.strictEqual(fs.existsSync(paths.continuityRoot()), false);
  assert.ok(logs.some((l) => l.includes('continuity data')));

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});
