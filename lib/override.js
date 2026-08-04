'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { atomicWriteFileSync } = require('./atomic-write');

// Time-boxed "continue at my own risk" flag. While an override is present and
// its `until` is in the future, Guardian stops hard-blocking this project --
// the user has explicitly chosen to keep working past the threshold instead of
// checkpointing. Expiry is the safety net: the block returns on its own.

function read(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(paths.overridePath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

function isActive(projectPath, now = Date.now()) {
  const o = read(projectPath);
  if (!o || !o.until) return false;
  const until = new Date(o.until).getTime();
  return Number.isFinite(until) && now < until;
}

function write(projectPath, minutes, reason, now = Date.now()) {
  const mins = Math.max(1, Number(minutes) || 0);
  const payload = {
    until: new Date(now + mins * 60 * 1000).toISOString(),
    createdAt: new Date(now).toISOString(),
    reason: reason || null,
  };
  const file = paths.overridePath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(payload, null, 2));
  return payload;
}

function clear(projectPath) {
  try {
    fs.rmSync(paths.overridePath(projectPath), { force: true });
  } catch {
    // best-effort
  }
}

module.exports = { read, isActive, write, clear };
