#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const paths = require('../lib/paths');

// Tools the documented /continuity-checkpoint flow actually needs: Bash to
// compute paths and atomically update pending.json, Write for the checkpoint
// file itself. Everything else is "new work" -- exactly what must stop once
// a checkpoint is pending and unconsumed.
const ALLOWED_WHILE_PENDING = new Set(['Bash', 'Write']);

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// PreToolUse hard stop: unlike PostToolUse/Stop (advisory only), a `block`
// decision here actually prevents the tool call from running. This is the
// real "halt the project" lever -- registered at the user-level settings.json,
// so it applies to every Claude Code project/terminal/IDE session, not just
// the one that tripped the threshold.
function main() {
  const input = readStdin();
  if (!input || !input.cwd || !input.tool_name) {
    return;
  }
  if (ALLOWED_WHILE_PENDING.has(input.tool_name)) {
    return;
  }

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(paths.pendingPath(input.cwd), 'utf8'));
  } catch {
    return;
  }
  if (!pending || pending.consumed !== false) {
    return;
  }

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Claude Quota Guardian: usage threshold hit and not yet checkpointed. Tool "${input.tool_name}" is blocked. Run /continuity-checkpoint now (it only needs Bash/Write, both still allowed), then end the turn.`,
  }));
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
