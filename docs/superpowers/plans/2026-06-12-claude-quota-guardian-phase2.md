# claude-quota-guardian Phase 2 — Watcher & Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the background quota-reset watcher and an automated install/uninstall flow, completing spec sections 5.5 and 9 (deferred from Phase 1).

**Architecture:** `watcher/quota-watcher.js` is a standalone script invoked periodically by the OS scheduler (Task Scheduler / launchd / systemd timer, with a cron fallback on Linux). Each run scans `~/.claude/session-continuity/*/pending.json` for projects waiting on a plan-quota reset, calls `getPlanUsage()`, and sends one OS notification per reset cycle (anti-spam via a `resetNotified` flag written back to `pending.json`). `bin/install.js` / `bin/uninstall.js` wire everything together: write `config.json`, merge/unmerge the Phase 1 hooks into `~/.claude/settings.json` (via new pure helpers in `lib/hooks-merge.js`, never clobbering unrelated hooks), copy/remove `continuity-checkpoint.md`, and register/unregister the watcher's OS schedule (via new pure descriptor builders in `lib/scheduled-task.js`, so the per-OS command/file shapes are unit-testable without actually running `schtasks`/`launchctl`/`systemctl`). `lib/paths.js` gains `homeDir`/`claudeHome`/`settingsPath`/`commandsDir` helpers (all respecting the existing `CQG_HOME` test override) so installer code never touches the real `~/.claude` during tests.

**Tech Stack:** Node.js ≥18, CommonJS, `node:test` (built-in runner), `node:readline` for interactive prompts, `node:child_process` for OS scheduler commands. No new npm dependencies.

**Branch:** create `feat/phase2-watcher-installer` from `master` before starting Task 1.

---

### Task 1: `lib/paths.js` — home/settings/commands helpers

**Files:**
- Modify: `lib/paths.js`
- Test: `tests/lib/paths.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/lib/paths.test.js` (after the existing tests, before the final blank line):

```js
test('homeDir respects CQG_HOME override', () => {
  const original = process.env.CQG_HOME;
  process.env.CQG_HOME = 'C:\\fake\\home';
  assert.strictEqual(paths.homeDir(), 'C:\\fake\\home');
  if (original === undefined) delete process.env.CQG_HOME;
  else process.env.CQG_HOME = original;
});

test('homeDir falls back to os.homedir() when CQG_HOME is unset', () => {
  const original = process.env.CQG_HOME;
  delete process.env.CQG_HOME;
  assert.strictEqual(paths.homeDir(), require('node:os').homedir());
  if (original !== undefined) process.env.CQG_HOME = original;
});

test('claudeHome, settingsPath, commandsDir live under homeDir/.claude', () => {
  const original = process.env.CQG_HOME;
  process.env.CQG_HOME = 'C:\\fake\\home';

  assert.strictEqual(paths.claudeHome(), path.join('C:\\fake\\home', '.claude'));
  assert.strictEqual(paths.settingsPath(), path.join('C:\\fake\\home', '.claude', 'settings.json'));
  assert.strictEqual(paths.commandsDir(), path.join('C:\\fake\\home', '.claude', 'commands'));

  if (original === undefined) delete process.env.CQG_HOME;
  else process.env.CQG_HOME = original;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/paths.test.js`
Expected: FAIL — `paths.homeDir is not a function` (and similarly for `claudeHome`/`settingsPath`/`commandsDir`).

- [ ] **Step 3: Replace `lib/paths.js`**

```js
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function homeDir() {
  return process.env.CQG_HOME || os.homedir();
}

function claudeHome() {
  return path.join(homeDir(), '.claude');
}

function continuityRoot() {
  return path.join(claudeHome(), 'session-continuity');
}

function projectHash(projectPath) {
  return crypto.createHash('sha1').update(path.resolve(projectPath)).digest('hex').slice(0, 12);
}

function projectDir(projectPath) {
  return path.join(continuityRoot(), projectHash(projectPath));
}

function pendingPath(projectPath) {
  return path.join(projectDir(projectPath), 'pending.json');
}

function checkpointPath(projectPath, timestamp) {
  return path.join(projectDir(projectPath), `checkpoint-${timestamp}.md`);
}

function configPath() {
  return path.join(continuityRoot(), 'config.json');
}

function logPath() {
  return path.join(continuityRoot(), 'watcher.log');
}

function settingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

function commandsDir() {
  return path.join(claudeHome(), 'commands');
}

module.exports = {
  homeDir,
  claudeHome,
  continuityRoot,
  projectHash,
  projectDir,
  pendingPath,
  checkpointPath,
  configPath,
  logPath,
  settingsPath,
  commandsDir,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/paths.test.js`
Expected: PASS — all tests (existing + new) green.

- [ ] **Step 5: Commit**

```bash
git add lib/paths.js tests/lib/paths.test.js
git commit -m "feat: add homeDir/claudeHome/settingsPath/commandsDir to lib/paths"
```

---

### Task 2: `lib/hooks-merge.js` — merge/remove hook entries in settings.json

**Files:**
- Create: `lib/hooks-merge.js`
- Test: `tests/lib/hooks-merge.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/hooks-merge.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { ensureHooksMerged, removeHooks } = require('../../lib/hooks-merge');

test('ensureHooksMerged adds hooks to empty settings', () => {
  const result = ensureHooksMerged({}, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
    { event: 'SessionStart', matcher: '*', command: 'node "resume-context.js"' },
  ]);

  assert.deepStrictEqual(result.hooks.PostToolUse, [
    { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
  ]);
  assert.deepStrictEqual(result.hooks.SessionStart, [
    { matcher: '*', hooks: [{ type: 'command', command: 'node "resume-context.js"' }] },
  ]);
});

test('ensureHooksMerged preserves existing unrelated hooks', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
      ],
    },
    otherSetting: true,
  };

  const result = ensureHooksMerged(existing, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
  ]);

  assert.strictEqual(result.otherSetting, true);
  assert.deepStrictEqual(result.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
    { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
  ]);
});

test('ensureHooksMerged is idempotent', () => {
  let result = ensureHooksMerged({}, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
  ]);
  result = ensureHooksMerged(result, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
  ]);

  assert.strictEqual(result.hooks.PostToolUse.length, 1);
  assert.strictEqual(result.hooks.PostToolUse[0].hooks.length, 1);
});

test('removeHooks removes only the matching command', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
        { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
      ],
    },
  };

  const result = removeHooks(existing, [
    { event: 'PostToolUse', command: 'node "check-usage.js"' },
  ]);

  assert.deepStrictEqual(result.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
  ]);
});

test('removeHooks cleans up empty event arrays and the hooks key', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
      ],
    },
  };

  const result = removeHooks(existing, [
    { event: 'PostToolUse', command: 'node "check-usage.js"' },
  ]);

  assert.strictEqual(result.hooks, undefined);
});

test('removeHooks on settings with no hooks is a no-op', () => {
  const existing = { someSetting: 1 };
  const result = removeHooks(existing, [{ event: 'PostToolUse', command: 'x' }]);
  assert.deepStrictEqual(result, existing);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/hooks-merge.test.js`
Expected: FAIL — `Cannot find module '../../lib/hooks-merge'`.

- [ ] **Step 3: Create `lib/hooks-merge.js`**

```js
'use strict';

function ensureHooksMerged(settings, additions) {
  const result = { ...settings, hooks: { ...(settings.hooks || {}) } };

  for (const { event, matcher, command } of additions) {
    const list = (result.hooks[event] || []).map((entry) => ({
      ...entry,
      hooks: [...(entry.hooks || [])],
    }));

    let entry = list.find((e) => e.matcher === matcher);
    if (!entry) {
      entry = { matcher, hooks: [] };
      list.push(entry);
    }

    if (!entry.hooks.some((h) => h.command === command)) {
      entry.hooks.push({ type: 'command', command });
    }

    result.hooks[event] = list;
  }

  return result;
}

function removeHooks(settings, removals) {
  if (!settings.hooks) return settings;

  const result = { ...settings, hooks: { ...settings.hooks } };

  for (const { event, command } of removals) {
    if (!result.hooks[event]) continue;

    const list = result.hooks[event]
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks || []).filter((h) => h.command !== command),
      }))
      .filter((entry) => entry.hooks.length > 0);

    if (list.length > 0) result.hooks[event] = list;
    else delete result.hooks[event];
  }

  if (Object.keys(result.hooks).length === 0) delete result.hooks;

  return result;
}

module.exports = { ensureHooksMerged, removeHooks };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/hooks-merge.test.js`
Expected: PASS — 6/6 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/hooks-merge.js tests/lib/hooks-merge.test.js
git commit -m "feat: add lib/hooks-merge for safe settings.json hook merging"
```

---

### Task 3: `lib/scheduled-task.js` — per-OS install/uninstall descriptors

**Files:**
- Create: `lib/scheduled-task.js`
- Test: `tests/lib/scheduled-task.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/scheduled-task.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const scheduledTask = require('../../lib/scheduled-task');

const OPTS = {
  nodePath: '/usr/bin/node',
  watcherPath: '/opt/cqg/watcher/quota-watcher.js',
  intervalMinutes: 15,
  logPath: '/home/user/.claude/session-continuity/watcher.log',
};

test('describeInstall for win32 returns a schtasks command with the interval', () => {
  const desc = scheduledTask.describeInstall('win32', OPTS);
  assert.strictEqual(desc.platform, 'win32');
  assert.strictEqual(desc.files.length, 0);
  assert.strictEqual(desc.commands.length, 1);
  const [cmd, ...args] = desc.commands[0];
  assert.strictEqual(cmd, 'schtasks');
  assert.ok(args.includes('/mo'));
  assert.ok(args.includes('15'));
  assert.ok(args.some((a) => a.includes(OPTS.watcherPath)));
});

test('describeInstall for darwin returns a launchd plist with StartInterval in seconds', () => {
  const desc = scheduledTask.describeInstall('darwin', OPTS);
  assert.strictEqual(desc.platform, 'darwin');
  assert.strictEqual(desc.files.length, 1);
  assert.match(desc.files[0].path, /LaunchAgents/);
  assert.match(desc.files[0].content, /<integer>900<\/integer>/);
  assert.ok(desc.files[0].content.includes(OPTS.watcherPath));
  assert.strictEqual(desc.commands[0][0], 'launchctl');
});

test('describeInstall for linux returns systemd unit files and a cron fallback', () => {
  const desc = scheduledTask.describeInstall('linux', OPTS);
  assert.strictEqual(desc.platform, 'linux');
  assert.strictEqual(desc.files.length, 2);
  assert.ok(desc.files[0].content.includes(OPTS.watcherPath));
  assert.match(desc.files[1].content, /OnUnitActiveSec=15min/);
  assert.deepStrictEqual(desc.commands[0], ['systemctl', '--user', 'enable', '--now', 'cqg-watcher.timer']);
  assert.match(desc.fallback.cronLine, /\*\/15 \* \* \* \*/);
  assert.ok(desc.fallback.cronLine.includes(OPTS.watcherPath));
});

test('describeUninstall returns the matching teardown commands per platform', () => {
  assert.deepStrictEqual(
    scheduledTask.describeUninstall('win32').commands[0],
    ['schtasks', '/delete', '/tn', scheduledTask.TASK_NAME, '/f']
  );

  const mac = scheduledTask.describeUninstall('darwin');
  assert.strictEqual(mac.commands[0][0], 'launchctl');
  assert.strictEqual(mac.filesToRemove.length, 1);

  const linux = scheduledTask.describeUninstall('linux');
  assert.deepStrictEqual(linux.commands[0], ['systemctl', '--user', 'disable', '--now', 'cqg-watcher.timer']);
  assert.strictEqual(linux.filesToRemove.length, 2);
  assert.match(linux.fallback.removeCronMatching, /cqg-watcher/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/scheduled-task.test.js`
Expected: FAIL — `Cannot find module '../../lib/scheduled-task'`.

- [ ] **Step 3: Create `lib/scheduled-task.js`**

```js
'use strict';

const TASK_NAME = 'ClaudeQuotaGuardianWatcher';
const LAUNCHD_LABEL = 'com.claude-quota-guardian.watcher';

function describeInstall(platform, { nodePath, watcherPath, intervalMinutes, logPath }) {
  if (platform === 'win32') {
    return {
      platform: 'win32',
      files: [],
      commands: [
        ['schtasks', '/create', '/tn', TASK_NAME, '/tr', `"${nodePath}" "${watcherPath}"`, '/sc', 'minute', '/mo', String(intervalMinutes), '/f'],
      ],
    };
  }

  if (platform === 'darwin') {
    const plistPath = `~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${nodePath}</string><string>${watcherPath}</string></array>
  <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
    return {
      platform: 'darwin',
      files: [{ path: plistPath, content: plist }],
      commands: [['launchctl', 'load', '-w', plistPath]],
    };
  }

  const servicePath = '~/.config/systemd/user/cqg-watcher.service';
  const timerPath = '~/.config/systemd/user/cqg-watcher.timer';
  const serviceContent = `[Unit]
Description=Claude Quota Guardian watcher

[Service]
Type=oneshot
ExecStart=${nodePath} ${watcherPath}
`;
  const timerContent = `[Unit]
Description=Run Claude Quota Guardian watcher periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=${intervalMinutes}min

[Install]
WantedBy=timers.target
`;
  return {
    platform: 'linux',
    files: [
      { path: servicePath, content: serviceContent },
      { path: timerPath, content: timerContent },
    ],
    commands: [['systemctl', '--user', 'enable', '--now', 'cqg-watcher.timer']],
    fallback: {
      cronLine: `*/${intervalMinutes} * * * * ${nodePath} ${watcherPath} >> ${logPath} 2>&1`,
    },
  };
}

function describeUninstall(platform) {
  if (platform === 'win32') {
    return {
      platform: 'win32',
      commands: [['schtasks', '/delete', '/tn', TASK_NAME, '/f']],
      filesToRemove: [],
    };
  }

  if (platform === 'darwin') {
    const plistPath = `~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
    return {
      platform: 'darwin',
      commands: [['launchctl', 'unload', '-w', plistPath]],
      filesToRemove: [plistPath],
    };
  }

  return {
    platform: 'linux',
    commands: [['systemctl', '--user', 'disable', '--now', 'cqg-watcher.timer']],
    filesToRemove: [
      '~/.config/systemd/user/cqg-watcher.service',
      '~/.config/systemd/user/cqg-watcher.timer',
    ],
    fallback: { removeCronMatching: 'cqg-watcher' },
  };
}

module.exports = { describeInstall, describeUninstall, TASK_NAME, LAUNCHD_LABEL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/scheduled-task.test.js`
Expected: PASS — 4/4 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/scheduled-task.js tests/lib/scheduled-task.test.js
git commit -m "feat: add lib/scheduled-task OS scheduler descriptors"
```

---

### Task 4: `watcher/quota-watcher.js` — background quota-reset watcher

**Files:**
- Create: `watcher/quota-watcher.js`
- Test: `tests/watcher/quota-watcher.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/watcher/quota-watcher.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/watcher/quota-watcher.test.js`
Expected: FAIL — `Cannot find module '../../watcher/quota-watcher'`.

- [ ] **Step 3: Create `watcher/quota-watcher.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const notify = require('../lib/notify');

function findPendingFiles(root) {
  if (!fs.existsSync(root)) return [];

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'pending.json'))
    .filter((file) => fs.existsSync(file));
}

function shouldNotifyReset(pending, now) {
  if (!pending || pending.resetNotified) return false;
  if (pending.triggeredBy !== 'plan' && pending.triggeredBy !== 'both') return false;
  if (!pending.planResetAtSeen) return false;

  return now.getTime() >= new Date(pending.planResetAtSeen).getTime();
}

function processPendingFile(pendingFile, { now, notifySend }) {
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    return { notified: false, projectName: null };
  }

  if (!shouldNotifyReset(pending, now)) {
    return { notified: false, projectName: pending.projectName || null };
  }

  notifySend(
    'Claude Quota Guardian',
    `Cuota de Claude reiniciada. Proyecto "${pending.projectName}" listo para continuar.`
  );

  pending.resetNotified = true;
  atomicWriteFileSync(pendingFile, JSON.stringify(pending, null, 2));

  return { notified: true, projectName: pending.projectName || null };
}

function runWatcherOnce({ now = new Date(), config = loadConfig(), notifySend = notify.send } = {}) {
  const root = paths.continuityRoot();
  const files = findPendingFiles(root);
  const send = config.notifications.enabled ? notifySend : () => {};

  let notified = 0;
  for (const file of files) {
    const result = processPendingFile(file, { now, notifySend: send });
    if (result.notified) notified += 1;
  }

  return { checked: files.length, notified };
}

function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(paths.logPath()), { recursive: true });
    fs.appendFileSync(paths.logPath(), line);
  } catch {
    // logging is best-effort: a failed write here must not crash the watcher
  }
}

function main() {
  const summary = runWatcherOnce();
  appendLog(`checked=${summary.checked} notified=${summary.notified}`);
}

if (require.main === module) {
  main();
}

module.exports = { findPendingFiles, shouldNotifyReset, processPendingFile, runWatcherOnce, appendLog, main };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/watcher/quota-watcher.test.js`
Expected: PASS — 8/8 tests green.

- [ ] **Step 5: Commit**

```bash
git add watcher/quota-watcher.js tests/watcher/quota-watcher.test.js
git commit -m "feat: add background quota-reset watcher with anti-spam notifications"
```

---

### Task 5: `bin/install.js` — automated installer

**Files:**
- Create: `bin/install.js`
- Test: `tests/bin/install.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/bin/install.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bin/install.test.js`
Expected: FAIL — `Cannot find module '../../bin/install'`.

- [ ] **Step 3: Create `bin/install.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../lib/paths');
const { DEFAULTS, loadConfig } = require('../lib/config');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const { ensureHooksMerged } = require('../lib/hooks-merge');
const scheduledTask = require('../lib/scheduled-task');

function deepMerge(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      result[key] = { ...base[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readJsonOrEmpty(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function installConfig({ configFilePath, overrides = {} }) {
  const existing = readJsonOrEmpty(configFilePath);
  const merged = deepMerge(deepMerge(DEFAULTS, existing), overrides);

  fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
  atomicWriteFileSync(configFilePath, JSON.stringify(merged, null, 2));
  return merged;
}

function buildHookAdditions(repoRoot) {
  return [
    { event: 'PostToolUse', matcher: '*', command: `node "${path.join(repoRoot, 'hooks', 'check-usage.js')}"` },
    { event: 'SessionStart', matcher: '*', command: `node "${path.join(repoRoot, 'hooks', 'resume-context.js')}"` },
  ];
}

function installHooks({ settingsFilePath, repoRoot }) {
  const existing = readJsonOrEmpty(settingsFilePath);
  const merged = ensureHooksMerged(existing, buildHookAdditions(repoRoot));

  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
  atomicWriteFileSync(settingsFilePath, JSON.stringify(merged, null, 2));
  return merged;
}

function installCommand({ repoRoot, commandsDirPath }) {
  const src = path.join(repoRoot, 'commands', 'continuity-checkpoint.md');
  const dest = path.join(commandsDirPath, 'continuity-checkpoint.md');

  fs.mkdirSync(commandsDirPath, { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

function expandHome(filePath) {
  if (filePath.startsWith('~/')) return path.join(paths.homeDir(), filePath.slice(2));
  return filePath;
}

function installSchedule({ platform, repoRoot, execFn = execFileSync }) {
  const desc = scheduledTask.describeInstall(platform, {
    nodePath: process.execPath,
    watcherPath: path.join(repoRoot, 'watcher', 'quota-watcher.js'),
    intervalMinutes: loadConfig().watcherIntervalMinutes,
    logPath: paths.logPath(),
  });

  try {
    for (const file of desc.files) {
      const target = expandHome(file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    for (const [cmd, ...args] of desc.commands) {
      execFn(cmd, args, { stdio: 'ignore' });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message, fallback: desc.fallback || null, descriptor: desc };
  }
}

function run({ repoRoot, platform = process.platform, execFn = execFileSync, log = console.log } = {}) {
  const config = installConfig({ configFilePath: paths.configPath() });
  const settings = installHooks({ settingsFilePath: paths.settingsPath(), repoRoot });
  const commandFile = installCommand({ repoRoot, commandsDirPath: paths.commandsDir() });
  const schedule = installSchedule({ platform, repoRoot, execFn });

  log(`config: ${paths.configPath()}`);
  log(`hooks merged into: ${paths.settingsPath()}`);
  log(`command installed: ${commandFile}`);
  if (schedule.success) {
    log('watcher schedule registered');
  } else {
    log(`watcher schedule NOT registered (${schedule.error}). Manual setup: see docs/configuration.md`);
  }

  return { config, settings, commandFile, schedule };
}

if (require.main === module) {
  run({ repoRoot: path.join(__dirname, '..') });
}

module.exports = {
  installConfig,
  buildHookAdditions,
  installHooks,
  installCommand,
  installSchedule,
  expandHome,
  run,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bin/install.test.js`
Expected: PASS — 7/7 tests green.

- [ ] **Step 5: Commit**

```bash
git add bin/install.js tests/bin/install.test.js
git commit -m "feat: add bin/install for automated hook, config and watcher setup"
```

---

### Task 6: `bin/uninstall.js` — automated uninstaller

**Files:**
- Create: `bin/uninstall.js`
- Test: `tests/bin/uninstall.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/bin/uninstall.test.js`:

```js
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
  assert.strictEqual(result.schedule.success, true);
  assert.strictEqual(result.purged, paths.continuityRoot());
  assert.strictEqual(fs.existsSync(paths.continuityRoot()), false);
  assert.ok(logs.some((l) => l.includes('continuity data')));

  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bin/uninstall.test.js`
Expected: FAIL — `Cannot find module '../../bin/uninstall'`.

- [ ] **Step 3: Create `bin/uninstall.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const { removeHooks } = require('../lib/hooks-merge');
const scheduledTask = require('../lib/scheduled-task');
const { buildHookAdditions } = require('./install');

function readJsonOrEmpty(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function uninstallHooks({ settingsFilePath, repoRoot }) {
  if (!fs.existsSync(settingsFilePath)) return {};

  const existing = readJsonOrEmpty(settingsFilePath);
  const removals = buildHookAdditions(repoRoot).map(({ event, command }) => ({ event, command }));
  const result = removeHooks(existing, removals);

  atomicWriteFileSync(settingsFilePath, JSON.stringify(result, null, 2));
  return result;
}

function uninstallCommand({ commandsDirPath }) {
  const target = path.join(commandsDirPath, 'continuity-checkpoint.md');
  if (!fs.existsSync(target)) return null;

  fs.rmSync(target);
  return target;
}

function expandHome(filePath) {
  if (filePath.startsWith('~/')) return path.join(paths.homeDir(), filePath.slice(2));
  return filePath;
}

function uninstallSchedule({ platform, execFn = execFileSync }) {
  const desc = scheduledTask.describeUninstall(platform);

  try {
    for (const [cmd, ...args] of desc.commands) {
      execFn(cmd, args, { stdio: 'ignore' });
    }
    for (const filePath of desc.filesToRemove) {
      const target = expandHome(filePath);
      if (fs.existsSync(target)) fs.rmSync(target);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message, fallback: desc.fallback || null, descriptor: desc };
  }
}

function purgeData() {
  const root = paths.continuityRoot();
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  return root;
}

function run({ repoRoot, platform = process.platform, execFn = execFileSync, purge = false, log = console.log } = {}) {
  const settings = uninstallHooks({ settingsFilePath: paths.settingsPath(), repoRoot });
  const commandFile = uninstallCommand({ commandsDirPath: paths.commandsDir() });
  const schedule = uninstallSchedule({ platform, execFn });

  log(`hooks removed from: ${paths.settingsPath()}`);
  log(commandFile ? `command removed: ${commandFile}` : 'command not found (already removed)');
  if (schedule.success) {
    log('watcher schedule unregistered');
  } else {
    log(`watcher schedule NOT unregistered (${schedule.error}). Manual cleanup: see docs/configuration.md`);
  }

  let purged = null;
  if (purge) {
    purged = purgeData();
    log(`removed continuity data: ${purged}`);
  }

  return { settings, commandFile, schedule, purged };
}

if (require.main === module) {
  run({ repoRoot: path.join(__dirname, '..'), purge: process.argv.includes('--purge') });
}

module.exports = { uninstallHooks, uninstallCommand, uninstallSchedule, purgeData, expandHome, run };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bin/uninstall.test.js`
Expected: PASS — 8/8 tests green.

- [ ] **Step 5: Commit**

```bash
git add bin/uninstall.js tests/bin/uninstall.test.js
git commit -m "feat: add bin/uninstall to remove hooks, command and watcher schedule"
```

---
