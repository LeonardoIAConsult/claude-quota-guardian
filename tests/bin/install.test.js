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

test('installHooks adds PreToolUse, PostToolUse, Stop and SessionStart hooks with absolute paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  const result = install.installHooks({ settingsFilePath, repoRoot: REPO_ROOT });

  const preToolUse = result.hooks.PreToolUse[0].hooks[0].command;
  const postToolUse = result.hooks.PostToolUse[0].hooks[0].command;
  const stop = result.hooks.Stop[0].hooks[0].command;
  const sessionStart = result.hooks.SessionStart[0].hooks[0].command;
  assert.match(preToolUse, /enforce-checkpoint\.js"$/);
  assert.match(postToolUse, /check-usage\.js"$/);
  assert.match(stop, /heartbeat-stop\.js"$/);
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

test('installStatusLine claims an empty statusLine slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  const result = install.installStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.strictEqual(result.claimed, true);
  assert.match(result.settings.statusLine.command, /statusline\.js"$/);
  assert.strictEqual(result.settings.statusLine.refreshInterval, install.STATUSLINE_REFRESH_SECONDS);

  const onDisk = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
  assert.strictEqual(onDisk.statusLine.command, result.settings.statusLine.command);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installStatusLine is idempotent and preserves unrelated settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFilePath, JSON.stringify({ someOtherKey: true }));

  install.installStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });
  const second = install.installStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.strictEqual(second.claimed, true);
  assert.strictEqual(second.settings.someOtherKey, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installStatusLine does not overwrite a statusLine already claimed by something else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFilePath, JSON.stringify({
    statusLine: { type: 'command', command: 'powershell -File caveman-statusline.ps1' },
  }));

  const result = install.installStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });

  assert.strictEqual(result.claimed, false);
  assert.strictEqual(result.existingCommand, 'powershell -File caveman-statusline.ps1');

  const onDisk = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
  assert.strictEqual(onDisk.statusLine.command, 'powershell -File caveman-statusline.ps1');

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

test('installStatusLine keeps a refreshInterval the user set on our own line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFilePath, JSON.stringify({
    statusLine: { type: 'command', command: install.statusLineCommand(REPO_ROOT), refreshInterval: 5 },
  }));

  const result = install.installStatusLine({ settingsFilePath, repoRoot: REPO_ROOT });
  assert.strictEqual(result.settings.statusLine.refreshInterval, 5);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installBar adds bar/ to CLAUDE_CODE_PLUGIN_DIRS, keeps other folders and env, is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFilePath, JSON.stringify({ env: { OTHER: '1', CLAUDE_CODE_PLUGIN_DIRS: '/my/mod' }, theme: 'dark' }));

  const first = install.installBar({ settingsFilePath, repoRoot: '/repo', delimiter: ':' });
  assert.strictEqual(first.added, true);
  assert.strictEqual(first.settings.env.CLAUDE_CODE_PLUGIN_DIRS, `/my/mod:${path.join('/repo', 'bar')}`);
  assert.strictEqual(first.settings.env.OTHER, '1');
  assert.strictEqual(first.settings.theme, 'dark');

  const second = install.installBar({ settingsFilePath, repoRoot: '/repo', delimiter: ':' });
  assert.strictEqual(second.added, false);
  const onDisk = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
  assert.strictEqual(onDisk.env.CLAUDE_CODE_PLUGIN_DIRS, `/my/mod:${path.join('/repo', 'bar')}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installBar works on a settings file with no env block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const settingsFilePath = path.join(dir, 'settings.json');

  const result = install.installBar({ settingsFilePath, repoRoot: REPO_ROOT });
  assert.strictEqual(result.settings.env.CLAUDE_CODE_PLUGIN_DIRS, path.join(REPO_ROOT, 'bar'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('installNativeHost writes the launcher and manifest under the continuity root and runs the registry commands', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  process.env.CQG_HOME = home;
  const calls = [];

  const result = install.installNativeHost({ platform: 'win32', repoRoot: REPO_ROOT, execFn: (cmd, args) => calls.push([cmd, ...args]) });
  assert.strictEqual(result.success, true);
  const hostDir = path.join(home, '.claude', 'session-continuity', 'native-host');
  assert.ok(fs.existsSync(path.join(hostDir, 'guardian-host.cmd')));
  const manifest = JSON.parse(fs.readFileSync(path.join(hostDir, 'com.leonardoantolinez.quota_guardian.json'), 'utf8'));
  assert.strictEqual(manifest.path, path.join(hostDir, 'guardian-host.cmd'));
  assert.strictEqual(calls.length, 4);
  assert.ok(calls.every((c) => c[0] === 'reg' && c[1] === 'add'));

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('installNativeHost reports failure instead of throwing when the registry refuses', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  process.env.CQG_HOME = home;

  const result = install.installNativeHost({ platform: 'win32', repoRoot: REPO_ROOT, execFn: () => { throw new Error('access denied'); } });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /access denied/);

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('run enables the bar and the browser bridge', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  process.env.CQG_HOME = home;

  const result = install.run({ repoRoot: REPO_ROOT, platform: 'linux', execFn: () => {}, log: () => {} });
  assert.strictEqual(result.host.success, true);
  assert.ok(result.settings.env.CLAUDE_CODE_PLUGIN_DIRS.includes(path.join(REPO_ROOT, 'bar')));
  assert.ok(result.settings.hooks.PostToolUse);
  assert.ok(result.settings.statusLine);
  assert.ok(fs.existsSync(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', 'com.leonardoantolinez.quota_guardian.json')));

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('installCommand also installs /guardian-continue, which the block message offers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-install-'));
  const commandsDirPath = path.join(dir, 'commands');

  install.installCommand({ repoRoot: REPO_ROOT, commandsDirPath });
  assert.ok(fs.existsSync(path.join(commandsDirPath, 'guardian-continue.md')));

  fs.rmSync(dir, { recursive: true, force: true });
});
