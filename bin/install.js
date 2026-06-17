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
    { event: 'PreToolUse', matcher: '*', command: `node "${path.join(repoRoot, 'hooks', 'enforce-checkpoint.js')}"` },
    { event: 'PostToolUse', matcher: '*', command: `node "${path.join(repoRoot, 'hooks', 'check-usage.js')}"` },
    { event: 'Stop', matcher: '*', command: `node "${path.join(repoRoot, 'hooks', 'heartbeat-stop.js')}"` },
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

// Claude Code's rate_limits (real, account-wide 5h/7d Pro/Max quota) is only
// ever delivered via the statusLine payload -- not via any PreToolUse/
// PostToolUse/Stop hook. But settings.json only supports ONE statusLine
// command (unlike hooks, which support arrays), so claiming this slot can
// collide with another plugin's status line (e.g. a badge script). Only
// claim it when nothing else already has -- never silently overwrite an
// existing statusLine, matching the "preserve user's existing settings"
// guarantee the rest of this installer follows.
function statusLineCommand(repoRoot) {
  return `node "${path.join(repoRoot, 'hooks', 'statusline.js')}"`;
}

function installStatusLine({ settingsFilePath, repoRoot }) {
  const existing = readJsonOrEmpty(settingsFilePath);
  const command = statusLineCommand(repoRoot);

  if (existing.statusLine && existing.statusLine.command && existing.statusLine.command !== command) {
    return { settings: existing, claimed: false, existingCommand: existing.statusLine.command };
  }

  const merged = { ...existing, statusLine: { type: 'command', command } };
  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
  atomicWriteFileSync(settingsFilePath, JSON.stringify(merged, null, 2));
  return { settings: merged, claimed: true };
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
  installHooks({ settingsFilePath: paths.settingsPath(), repoRoot });
  const statusLine = installStatusLine({ settingsFilePath: paths.settingsPath(), repoRoot });
  const commandFile = installCommand({ repoRoot, commandsDirPath: paths.commandsDir() });
  const schedule = installSchedule({ platform, repoRoot, execFn });

  log(`config: ${paths.configPath()}`);
  log(`hooks merged into: ${paths.settingsPath()}`);
  if (statusLine.claimed) {
    log('statusLine registered (enables real account-wide rate_limits tracking)');
  } else {
    log(`statusLine NOT registered -- already set to: ${statusLine.existingCommand}. Combine manually, see docs/configuration.md`);
  }
  log(`command installed: ${commandFile}`);
  if (schedule.success) {
    log('watcher schedule registered');
  } else {
    log(`watcher schedule NOT registered (${schedule.error}). Manual setup: see docs/configuration.md`);
  }

  return { config, settings: statusLine.settings, commandFile, schedule };
}

if (require.main === module) {
  run({ repoRoot: path.join(__dirname, '..') });
}

module.exports = {
  installConfig,
  buildHookAdditions,
  installHooks,
  statusLineCommand,
  installStatusLine,
  installCommand,
  installSchedule,
  expandHome,
  run,
};
