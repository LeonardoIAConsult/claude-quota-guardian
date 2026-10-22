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

// UserPromptSubmit: the request to the API starts when the message is sent,
// so this is the earliest real use of the prompt cache. It keeps the cache
// countdown alive through a long turn that runs no tool. Only stamps the
// session's activity in state.json: no threshold check, no ccusage, and it
// never prints (exit 0 with no output can neither block nor edit the prompt).
function main() {
  const input = readStdin();
  if (!input) return;
  stampSession(input, { lastActivityAt: new Date().toISOString() });
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[prompt-submit] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
