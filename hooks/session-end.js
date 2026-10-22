#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const paths = require('../lib/paths');
const { stampSession } = require('../lib/cache-sessions');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// SessionEnd: the session is over (exit, /clear, a routine or `claude -p`
// finishing), so its cache has nobody left to protect. Marks it ended in
// state.json and the extension's list stops showing it. Claude Code gives
// this event a short budget (1.5 s) and cannot be blocked from here: write
// one small file and exit 0. A killed process never gets here; its row
// leaves when its cache expires.
function main() {
  const input = readStdin();
  if (!input) return;
  stampSession(input, { endedAt: new Date().toISOString() });
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[session-end] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
