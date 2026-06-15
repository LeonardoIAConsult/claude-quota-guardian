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

const ADAPTIVE = {
  watcherIntervalMinutes: 15,
  adaptiveWatcher: {
    enabled: true,
    baseMinutes: 15,
    tiers: [{ atPct: 90, minutes: 3 }, { atPct: 98, minutes: 1 }],
  },
};

test('pickIntervalMinutes returns base below the lowest tier', () => {
  assert.strictEqual(scheduledTask.pickIntervalMinutes(50, ADAPTIVE), 15);
  assert.strictEqual(scheduledTask.pickIntervalMinutes(89.9, ADAPTIVE), 15);
});

test('pickIntervalMinutes ramps to 3min at 90% and 1min at 98%', () => {
  assert.strictEqual(scheduledTask.pickIntervalMinutes(90, ADAPTIVE), 3);
  assert.strictEqual(scheduledTask.pickIntervalMinutes(95, ADAPTIVE), 3);
  assert.strictEqual(scheduledTask.pickIntervalMinutes(98, ADAPTIVE), 1);
  assert.strictEqual(scheduledTask.pickIntervalMinutes(99.9, ADAPTIVE), 1);
});

test('pickIntervalMinutes returns base for null usage', () => {
  assert.strictEqual(scheduledTask.pickIntervalMinutes(null, ADAPTIVE), 15);
});

test('describeReschedule for win32 re-creates the task with /f and new interval', () => {
  const desc = scheduledTask.describeReschedule('win32', { ...OPTS, intervalMinutes: 3 });
  assert.strictEqual(desc.platform, 'win32');
  const args = desc.commands[0];
  assert.strictEqual(args[0], 'schtasks');
  assert.ok(args.includes('/create'));
  assert.ok(args.includes('/f'));
  assert.ok(args.includes('/mo'));
  assert.ok(args.includes('3'));
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
