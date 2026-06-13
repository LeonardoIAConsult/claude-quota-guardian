const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../../bin/install');
const { DEFAULTS } = require('../../lib/config');

const REPO_ROOT = path.join(__dirname, '..', '..');

test('installConfig writes defaults when no config exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const configFilePath = path.join(dir, 'config.json');

  const result = install.installConfig({ configFilePath });
  assert.deepStrictEqual(result, DEFAULTS);

  const onDisk = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
  assert.deepStrictEqual(onDisk, DEFAULTS);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installConfig preserves existing overrides and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const configFilePath = path.join(dir, 'config.json');

  fs.writeFileSync(configFilePath, JSON.stringify({ plan: 'pro', thresholds: { context: 0.9 } }));

  const result = install.installConfig({ configFilePath });
  assert.strictEqual(result.plan, 'pro');
  assert.strictEqual(result.thresholds.context, 0.9);
  assert.strictEqual(result.thresholds.plan, DEFAULTS.thresholds.plan);

  const second = install.installConfig({ configFilePath });
  assert.deepStrictEqual(second, result);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installHooks adds PostToolUse and SessionStart hooks with absolute paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  const result = install.installHooks({ settingsFilePath, repoRoot: REPO_ROOT });

  const postToolUse = result.hooks.PostToolUse[0].hooks[0].command;
  const sessionStart = result.hooks.SessionStart[0].hooks[0].command;
  assert.match(postToolUse, /check-usage\.js"$/);
  assert.match(sessionStart, /resume-context\.js"$/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installHooks preserves unrelated existing hooks and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  fs.writeFileSync(settingsFilePath, JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.js' }] }] },
  }));

  install.installHooks({ settingsFilePath, repoRoot: REPO_ROOT });
  const result = install.installHooks({ settingsFilePath, repoRoot: REPO_ROOT });

  const postToolUse = result.hooks.PostToolUse;
  assert.strictEqual(postToolUse.length, 2);
  assert.strictEqual(postToolUse[0].hooks[0].command, 'node other.js');
  assert.strictEqual(postToolUse[1].hooks.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installCommand copies continuity-checkpoint.md into commandsDir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const commandsDirPath = path.join(dir, 'commands');

  const dest = install.installCommand({ repoRoot: REPO_ROOT, commandsDirPath });

  assert.strictEqual(dest, path.join(commandsDirPath, 'continuity-checkpoint.md'));
  assert.ok(fs.existsSync(dest));
  const src = fs.readFileSync(path.join(REPO_ROOT, 'commands', 'continuity-checkpoint.md'), 'utf8');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), src);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installSchedule succeeds and writes files when execFn does not throw', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  process.env.CQG_HOME = home;

  const calls = [];
  const result = install.installSchedule({
    platform: 'linux',
    repoRoot: REPO_ROOT,
    execFn: (cmd, args) => calls.push([cmd, ...args]),
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(calls.length, 1);
  assert.ok(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'cqg-watcher.service')));
  assert.ok(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'cqg-watcher.timer')));

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('installSchedule returns success:false with fallback when execFn throws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  process.env.CQG_HOME = home;

  const result = install.installSchedule({
    platform: 'linux',
    repoRoot: REPO_ROOT,
    execFn: () => { throw new Error('systemctl not found'); },
  });

  assert.strictEqual(result.success, false);
  assert.match(result.error, /systemctl not found/);
  assert.match(result.fallback.cronLine, /quota-watcher\.js/);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('run orchestrates config, hooks, command and schedule', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  process.env.CQG_HOME = home;

  const logs = [];
  const result = install.run({
    repoRoot: REPO_ROOT,
    platform: 'linux',
    execFn: () => {},
    log: (msg) => logs.push(msg),
  });

  assert.ok(result.config);
  assert.ok(result.settings.hooks.PostToolUse);
  assert.ok(fs.existsSync(result.commandFile));
  assert.strictEqual(result.schedule.success, true);
  assert.ok(logs.length > 0);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});
