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

function main() {
  const input = readStdin();
  if (!input || !input.transcript_path || !input.cwd) {
    return;
  }

  const reason = performCheck(input, { config: loadConfig() });
  if (!reason) return;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[check-usage] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
