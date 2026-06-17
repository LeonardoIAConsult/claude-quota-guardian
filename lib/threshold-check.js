'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStatus } = require('./usage-monitor');
const paths = require('./paths');
const { atomicWriteFileSync } = require('./atomic-write');
const notify = require('./notify');

const RENOTIFY_INTERVAL_MS = 5 * 60 * 1000;

function blockReason(triggeredBy) {
  return `Usage at threshold (${triggeredBy}). Stop the current task now: do not start new work. Run /continuity-checkpoint to save a resumable checkpoint, then end the turn.`;
}

function readPending(pendingFile) {
  try {
    return JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    return null;
  }
}

// Shared by every threshold-aware hook (PostToolUse, Stop). Always writes the
// heartbeat first -- even with a pending checkpoint outstanding -- so the
// watcher's adaptive polling (15 -> 3 -> 1 min) and re-notify logic keep
// working all the way to 100%, instead of going dark after the first trigger.
// Returns a block reason string once usage is at/over threshold (caller
// decides whether emitting `decision: block` makes sense for its event type),
// or null when usage is below threshold.
function performCheck(input, { config }) {
  const pendingFile = paths.pendingPath(input.cwd);
  const pending = readPending(pendingFile);

  const status = getStatus({ transcriptPath: input.transcript_path, config });

  const maxPct = Math.max(
    status.contextPct == null ? 0 : status.contextPct,
    status.planPct == null ? 0 : status.planPct
  );
  try {
    atomicWriteFileSync(paths.statePath(input.cwd), JSON.stringify({
      maxPct: Math.round(maxPct * 10) / 10,
      contextPct: status.contextPct,
      planPct: status.planPct,
      sessionId: input.session_id || null,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {
    // heartbeat is best-effort: never block the hook on a failed state write
  }

  if (!status.anyAtThreshold) return null;

  const alreadyPending = pending && pending.consumed === false;

  if (!alreadyPending) {
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
      lastNotifiedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(pendingFile, JSON.stringify(newPending, null, 2));
    const pctShown = Math.max(newPending.pctAtTrigger.context || 0, newPending.pctAtTrigger.plan || 0);
    notify.send('Claude Quota Guardian', `Uso al ${pctShown}% — guardando progreso...`);
  } else {
    // Still above threshold and not yet checkpointed: re-notify periodically
    // instead of going silent after the one easily-missed initial toast.
    const last = pending.lastNotifiedAt ? new Date(pending.lastNotifiedAt).getTime() : 0;
    if (Date.now() - last >= RENOTIFY_INTERVAL_MS) {
      const refreshed = { ...pending, lastNotifiedAt: new Date().toISOString() };
      atomicWriteFileSync(pendingFile, JSON.stringify(refreshed, null, 2));
      const pct = pending.pctAtTrigger || {};
      const pctShown = Math.max(pct.context || 0, pct.plan || 0);
      notify.send('Claude Quota Guardian', `Seguís sobre el umbral (${pctShown}%) — falta /continuity-checkpoint.`);
    }
  }

  return blockReason(status.triggeredBy);
}

module.exports = { performCheck, RENOTIFY_INTERVAL_MS };
