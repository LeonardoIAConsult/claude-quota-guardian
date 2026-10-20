'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../lib/paths');
const { DEFAULTS, loadConfig } = require('../lib/config');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const { ensureHooksMerged } = require('../lib/hooks-merge');
const scheduledTask = require('../lib/scheduled-task');
const nativeHost = require('../lib/native-host');

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

  // refreshInterval re-runs the line while the session is idle, so the cache
  // countdown keeps moving without a new message. A value the user already set
  // on our line is kept.
  const refreshInterval = (existing.statusLine && existing.statusLine.refreshInterval) ?? STATUSLINE_REFRESH_SECONDS;
  const merged = { ...existing, statusLine: { type: 'command', command, refreshInterval } };
  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
  atomicWriteFileSync(settingsFilePath, JSON.stringify(merged, null, 2));
  return { settings: merged, claimed: true };
}

const STATUSLINE_REFRESH_SECONDS = 30;

// The bar above the prompt (bar/) is a hooks module, loaded as a plugin folder
// through CLAUDE_CODE_PLUGIN_DIRS in settings.json's env block. The variable is
// a path list, so other folders already in it are kept.
const PLUGIN_DIRS_VAR = 'CLAUDE_CODE_PLUGIN_DIRS';

function barDir(repoRoot) {
  return path.join(repoRoot, 'bar');
}

function splitPathList(value, delimiter) {
  return String(value || '').split(delimiter).map((p) => p.trim()).filter(Boolean);
}

// Windows paths compare case-insensitively.
function samePath(a, b, platform = process.platform) {
  const norm = (p) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

// The bar installed from the marketplace (/plugin install quota-guardian-bar)
// would load twice if we also listed our folder: two bars, two timers.
function barInstalledAsPlugin(installedPluginsPath) {
  const installed = readJsonOrEmpty(installedPluginsPath);
  return Object.keys(installed.plugins || {}).some((id) => id.startsWith('quota-guardian-bar@'));
}

function installBar({ settingsFilePath, repoRoot, delimiter = path.delimiter, installedPluginsPath = paths.installedPluginsPath() }) {
  const existing = readJsonOrEmpty(settingsFilePath);
  const env = { ...(existing.env || {}) };
  const dirs = splitPathList(env[PLUGIN_DIRS_VAR], delimiter);
  const dir = barDir(repoRoot);

  if (dirs.some((d) => samePath(d, dir))) return { settings: existing, added: false };
  if (barInstalledAsPlugin(installedPluginsPath)) return { settings: existing, added: false, asPlugin: true };

  env[PLUGIN_DIRS_VAR] = [...dirs, dir].join(delimiter);
  const merged = { ...existing, env };
  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
  atomicWriteFileSync(settingsFilePath, JSON.stringify(merged, null, 2));
  return { settings: merged, added: true };
}

// Registers native-host/guardian-host.js with Chrome, Edge and Brave so the
// extension can show the cache countdown (see lib/native-host.js).
function installNativeHost({ platform, repoRoot, execFn = execFileSync }) {
  const desc = nativeHost.describeInstall(platform, {
    nodePath: process.execPath,
    hostScript: path.join(repoRoot, 'native-host', 'guardian-host.js'),
  });

  try {
    for (const file of desc.files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content);
      if (file.mode) fs.chmodSync(file.path, file.mode);
    }
    for (const [cmd, ...args] of desc.commands) {
      execFn(cmd, args, { stdio: 'ignore' });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// /continuity-checkpoint is the main flow; /guardian-continue is the escape
// hatch the block message offers, so it must be installed alongside it.
const COMMAND_FILES = ['continuity-checkpoint.md', 'guardian-continue.md'];

function installCommand({ repoRoot, commandsDirPath }) {
  fs.mkdirSync(commandsDirPath, { recursive: true });
  for (const name of COMMAND_FILES) {
    fs.copyFileSync(path.join(repoRoot, 'commands', name), path.join(commandsDirPath, name));
  }
  return path.join(commandsDirPath, COMMAND_FILES[0]);
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
  const bar = installBar({ settingsFilePath: paths.settingsPath(), repoRoot });
  const host = installNativeHost({ platform, repoRoot, execFn });

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
  if (bar.asPlugin) {
    log('cache bar already installed as the quota-guardian-bar plugin (not added again)');
  } else {
    log(bar.added ? 'cache bar enabled (shows above the prompt from the next session)' : 'cache bar already enabled');
  }
  if (host.success) {
    log('browser bridge registered (the extension can show the cache countdown)');
  } else {
    log(`browser bridge NOT registered (${host.error}). The extension still shows your quota.`);
  }

  return { config, settings: bar.settings, commandFile, schedule, bar, host };
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
  COMMAND_FILES,
  installSchedule,
  STATUSLINE_REFRESH_SECONDS,
  PLUGIN_DIRS_VAR,
  barDir,
  splitPathList,
  samePath,
  barInstalledAsPlugin,
  installBar,
  installNativeHost,
  expandHome,
  run,
};
