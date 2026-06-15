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

// Map the current highest usage % to a polling interval. Tiers shorten the
// interval as usage climbs; below the lowest tier we fall back to baseMinutes.
function pickIntervalMinutes(maxPct, config = {}) {
  const adaptive = config.adaptiveWatcher || {};
  const base = adaptive.baseMinutes != null ? adaptive.baseMinutes : (config.watcherIntervalMinutes || 15);
  if (maxPct == null || !Array.isArray(adaptive.tiers)) return base;

  let chosen = base;
  let chosenAt = -Infinity;
  for (const tier of adaptive.tiers) {
    if (tier && typeof tier.atPct === 'number' && maxPct >= tier.atPct && tier.atPct >= chosenAt) {
      chosen = tier.minutes;
      chosenAt = tier.atPct;
    }
  }
  return chosen;
}

// Commands that re-register the watcher schedule at a new interval. On win32 a
// re-create with /f overwrites the existing task in place. darwin/linux are
// re-derived from describeInstall (load is idempotent enough for our use).
function describeReschedule(platform, opts) {
  if (platform === 'win32') {
    return {
      platform: 'win32',
      commands: [
        ['schtasks', '/create', '/tn', TASK_NAME, '/tr', `"${opts.nodePath}" "${opts.watcherPath}"`, '/sc', 'minute', '/mo', String(opts.intervalMinutes), '/f'],
      ],
    };
  }
  return describeInstall(platform, opts);
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

module.exports = { describeInstall, describeReschedule, describeUninstall, pickIntervalMinutes, TASK_NAME, LAUNCHD_LABEL };
