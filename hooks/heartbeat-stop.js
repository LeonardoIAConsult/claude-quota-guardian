#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { loadConfig } = require('../lib/config');
const paths = require('../lib/paths');
const { performCheck } = require('../lib/threshold-check');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// Runs on the Stop event (end of every assistant turn, with or without tool
// calls) to close the PostToolUse blind spot: a stretch of pure-text turns
// produces zero PostToolUse hooks, so usage can climb unnoticed between tool
// calls. This hook only heartbeats/notifies -- it must NOT emit
// `decision: block`, because for the Stop event that decision means "prevent
// the agent from stopping," the opposite of what we want at high usage.
function main() {
  const input = readStdin();
  if (!input || !input.transcript_path || !input.cwd) {
    return;
  }

  performCheck(input, { config: loadConfig() });
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[heartbeat-stop] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
