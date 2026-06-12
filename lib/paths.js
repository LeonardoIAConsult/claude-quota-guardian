'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function continuityRoot() {
  const base = process.env.CQG_HOME || os.homedir();
  return path.join(base, '.claude', 'session-continuity');
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

module.exports = {
  continuityRoot,
  projectHash,
  projectDir,
  pendingPath,
  checkpointPath,
  configPath,
  logPath,
};
