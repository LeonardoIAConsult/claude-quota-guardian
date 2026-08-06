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

function statePath(projectPath) {
  return path.join(projectDir(projectPath), 'state.json');
}

// "Continue at my own risk" grace flag: while present and unexpired, the
// enforce-checkpoint hard block stands down for this project (see lib/override).
function overridePath(projectPath) {
  return path.join(projectDir(projectPath), 'override.json');
}

function watcherStatePath() {
  return path.join(continuityRoot(), 'watcher-state.json');
}

function codexHome() {
  return process.env.CQG_CODEX_HOME || path.join(homeDir(), '.codex');
}

// Per-session state dir for non-Claude providers, keyed by something stable
// for the session (e.g. the rollout file path). Same `<name>/state.json`
// shape as project dirs so the watcher's readLiveMaxPct sees both alike.
function providerStateDir(provider, key) {
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 12);
  return path.join(continuityRoot(), `${provider}-${hash}`);
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
  statePath,
  overridePath,
  watcherStatePath,
  codexHome,
  providerStateDir,
  checkpointPath,
  configPath,
  logPath,
  settingsPath,
  commandsDir,
};
