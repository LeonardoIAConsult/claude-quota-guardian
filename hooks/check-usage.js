#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStatus } = require('../lib/usage-monitor');
const { loadConfig } = require('../lib/config');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const notify = require('../lib/notify');

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

  const pendingFile = paths.pendingPath(input.cwd);

  let pending = null;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    pending = null;
  }
  if (pending && pending.consumed === false) {
    return; // already pending — idempotent no-op
  }

  const config = loadConfig();
  const status = getStatus({ transcriptPath: input.transcript_path, config });

  if (!status.anyAtThreshold) {
    return;
  }

  const newPending = {
    projectPath: input.cwd,
    projectName: path.basename(input.cwd),
    sessionId: input.session_id || null,
    triggeredBy: status.triggeredBy,
    pctAtTrigger: {
      context: status.contextPct === null ? null : Math.round(status.contextPct * 10) / 10,
      plan: status.planPct === null ? null : Math.round(status.planPct * 10) / 10,
    },
    triggeredAt: new Date().toISOString(),
    checkpointFile: null,
    consumed: false,
    consumedAt: null,
    planResetAtSeen: status.planResetAt,
  };

  atomicWriteFileSync(pendingFile, JSON.stringify(newPending, null, 2));

  const pctShown = Math.max(newPending.pctAtTrigger.context || 0, newPending.pctAtTrigger.plan || 0);
  notify.send('Claude Quota Guardian', `Uso al ${pctShown}% — guardando progreso...`);

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Usage at threshold (${status.triggeredBy}). Stop the current task now: do not start new work. Run /continuity-checkpoint to save a resumable checkpoint, then end the turn.`,
  }));
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
