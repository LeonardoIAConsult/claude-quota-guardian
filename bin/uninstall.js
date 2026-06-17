'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const { removeHooks } = require('../lib/hooks-merge');
const scheduledTask = require('../lib/scheduled-task');
const { buildHookAdditions, statusLineCommand } = require('./install');

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

// Only release the statusLine slot when it's still exactly the command
// install.js wrote -- if the user has since pointed it elsewhere (combined
// it with another plugin's badge, etc.), leave it alone rather than
// silently deleting whatever is there now.
function uninstallStatusLine({ settingsFilePath, repoRoot }) {
  if (!fs.existsSync(settingsFilePath)) return { removed: false };

  const existing = readJsonOrEmpty(settingsFilePath);
  if (!existing.statusLine || existing.statusLine.command !== statusLineCommand(repoRoot)) {
    return { removed: false };
  }

  const result = { ...existing };
  delete result.statusLine;
  atomicWriteFileSync(settingsFilePath, JSON.stringify(result, null, 2));
  return { removed: true };
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
  const statusLine = uninstallStatusLine({ settingsFilePath: paths.settingsPath(), repoRoot });
  const commandFile = uninstallCommand({ commandsDirPath: paths.commandsDir() });
  const schedule = uninstallSchedule({ platform, execFn });

  log(`hooks removed from: ${paths.settingsPath()}`);
  log(statusLine.removed ? 'statusLine unregistered' : 'statusLine left untouched (not owned by claude-quota-guardian, or already removed)');
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

  return { settings, statusLine, commandFile, schedule, purged };
}

if (require.main === module) {
  run({ repoRoot: path.join(__dirname, '..'), purge: process.argv.includes('--purge') });
}

module.exports = { uninstallHooks, uninstallStatusLine, uninstallCommand, uninstallSchedule, purgeData, expandHome, run };
