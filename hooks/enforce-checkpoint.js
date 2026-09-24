#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const paths = require('../lib/paths');
const { enforceDecision } = require('../lib/enforce');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// PreToolUse hard stop: unlike PostToolUse/Stop (advisory only), a `block`
// decision here actually prevents the tool call from running. This is the
// real "halt the work" lever for the session that tripped the threshold. The
// decision itself (allowlist, session scope, /guardian-continue override)
// lives in lib/enforce so it is unit-tested; this hook only prints it.
function main() {
  const decision = enforceDecision(readStdin());
  if (decision) process.stdout.write(JSON.stringify(decision));
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[enforce-checkpoint] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
