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

function watcherStatePath() {
  return path.join(continuityRoot(), 'watcher-state.json');
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
  watcherStatePath,
  checkpointPath,
  configPath,
  logPath,
  settingsPath,
  commandsDir,
};
