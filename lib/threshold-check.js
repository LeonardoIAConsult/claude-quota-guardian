'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStatus } = require('./usage-monitor');
const paths = require('./paths');
const { atomicWriteFileSync } = require('./atomic-write');
const notify = require('./notify');

const RENOTIFY_INTERVAL_MS = 5 * 60 * 1000;
// Guardian only enforces on the terminal surface. Any other entrypoint
// (claude-desktop, IDE variants, unknown future values, or a transcript with
// no entrypoint stamp at all) is heartbeat-only: state.json keeps flowing for
// the watcher, but no pending checkpoint, no block, no notifications.
const CLI_ENTRYPOINT = 'cli';

function blockReason(triggeredBy) {
  return `Usage at threshold (${triggeredBy}). Stop the current task now: do not start new work. Run /continuity-checkpoint to save a resumable checkpoint, then end the turn.`;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  const pending = readJsonSafe(pendingFile);
  const statePath = paths.statePath(input.cwd);
  const prevState = readJsonSafe(statePath);

  // hooks/statusline.js caches the account-wide rate_limits signal (a separate
  // hook with a separate payload, refreshed on its own cadence) into this same
  // state.json -- read it back here so the PostToolUse/Stop decision can react
  // to it too, instead of only ever seeing local context + ccusage.
  const rateLimitPct = (prevState && typeof prevState.rateLimitPct === 'number') ? prevState.rateLimitPct : null;
  const rateLimitResetAt = (prevState && prevState.rateLimitResetAt) || null;

  // Throttle ccusage (a subprocess, 1-2s typical) to once every
  // planCheckIntervalToolCalls checks instead of every single one -- reuse
  // the cached reading from state.json on the calls in between.
  const cachedPlan = (prevState && typeof prevState.cachedPlanPct === 'number')
    ? { available: true, pct: prevState.cachedPlanPct, resetAt: prevState.cachedPlanResetAt || null }
    : null;
  const prevPlanCheckCounter = (prevState && typeof prevState.planCheckCounter === 'number') ? prevState.planCheckCounter : 0;
  const thisPlanCheckCounter = prevPlanCheckCounter + 1;

  const status = getStatus({
    transcriptPath: input.transcript_path,
    config,
    cachedRateLimit: rateLimitPct !== null ? { pct: rateLimitPct, resetAt: rateLimitResetAt } : null,
    cachedPlan,
    planCheckCounter: thisPlanCheckCounter,
  });
  const entrypoint = status.entrypoint;
  const isCli = entrypoint === CLI_ENTRYPOINT;

  const planEnabled = config.plan !== 'none';
  const nextPlanCheckCounter = planEnabled ? (status.planUsage.due ? 0 : thisPlanCheckCounter) : 0;
  const cachedPlanPct = (planEnabled && status.planUsage.available) ? status.planUsage.pct : null;
  const cachedPlanResetAt = (planEnabled && status.planUsage.available) ? (status.planUsage.resetAt || null) : null;

  const maxPct = Math.max(
    status.contextPct == null ? 0 : status.contextPct,
    status.planPct == null ? 0 : status.planPct
  );

  try {
    atomicWriteFileSync(statePath, JSON.stringify({
      maxPct: Math.round(maxPct * 10) / 10,
      contextPct: status.contextPct,
      planPct: status.planPct,
      rateLimitPct,
      rateLimitResetAt,
      planCheckCounter: nextPlanCheckCounter,
      cachedPlanPct,
      cachedPlanResetAt,
      sessionId: input.session_id || null,
      entrypoint,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {
    // heartbeat is best-effort: never block the hook on a failed state write
  }

  // Enforcement is terminal-only: any non-CLI surface got its heartbeat above
  // and stops here -- no pending checkpoint, no block, no notifications.
  if (!isCli) return null;

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
