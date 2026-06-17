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
