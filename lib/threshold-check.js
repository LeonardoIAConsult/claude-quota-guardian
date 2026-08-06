'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStatus } = require('./usage-monitor');
const paths = require('./paths');
const { atomicWriteFileSync } = require('./atomic-write');
const notify = require('./notify');
const override = require('./override');
const { weeklyForModel } = require('./rate-limits');

const RENOTIFY_INTERVAL_MS = 5 * 60 * 1000;
// Guardian only enforces on the terminal surface. Any other entrypoint
// (claude-desktop, IDE variants, unknown future values, or a transcript with
// no entrypoint stamp at all) is heartbeat-only: state.json keeps flowing for
// the watcher, but no pending checkpoint, no block, no notifications.
const CLI_ENTRYPOINT = 'cli';
// Claude Code Desktop gets the notify-only tier (like non-Claude providers):
// OS warnings at thresholds.desktopWarn / thresholds.plan, but never a pending
// checkpoint and never a hard block -- Desktop has no reliable "end the turn
// now" affordance, so blocking there would just strand the session.
const DESKTOP_ENTRYPOINT = 'claude-desktop';

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

// Two independent Desktop warnings, each with its own re-notify timestamp,
// because the fix differs by signal: local context -> open a fresh
// conversation (resets context); account-wide plan/rate-limit -> only the
// quota reset helps, a new conversation does not.
function performDesktopWarn({ config, status, prevState }) {
  let lastDesktopWarnAt = (prevState && prevState.lastDesktopWarnAt) || null;
  let lastDesktopPlanWarnAt = (prevState && prevState.lastDesktopPlanWarnAt) || null;
  const warnAt = config.thresholds.desktopWarn;
  if (warnAt == null) return { lastDesktopWarnAt, lastDesktopPlanWarnAt };

  const contextWarnHit = status.contextPct !== null && (status.contextPct / 100) >= warnAt;
  if (contextWarnHit) {
    const last = lastDesktopWarnAt ? new Date(lastDesktopWarnAt).getTime() : 0;
    if (Date.now() - last >= RENOTIFY_INTERVAL_MS) {
      lastDesktopWarnAt = new Date().toISOString();
      const pctShown = Math.round(status.contextPct * 10) / 10;
      notify.send('Claude Quota Guardian', `Desktop: conversación al ${pctShown}% de contexto — abrí una conversación nueva para seguir sin corte.`, config);
    }
  }

  const planWarnHit = status.planPct !== null && (status.planPct / 100) >= config.thresholds.plan;
  if (planWarnHit) {
    const last = lastDesktopPlanWarnAt ? new Date(lastDesktopPlanWarnAt).getTime() : 0;
    if (Date.now() - last >= RENOTIFY_INTERVAL_MS) {
      lastDesktopPlanWarnAt = new Date().toISOString();
      const pctShown = Math.round(status.planPct * 10) / 10;
      const resetTxt = status.planResetAt ? ` (resetea ${new Date(status.planResetAt).toLocaleString()})` : '';
      notify.send('Claude Quota Guardian', `Desktop: cuota de tu cuenta al ${pctShown}%${resetTxt} — pausá hasta el reset; otra conversación no libera esta cuota.`, config);
    }
  }

  return { lastDesktopWarnAt, lastDesktopPlanWarnAt };
}

function isHighTierModel(model, markers) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return (markers || ['opus']).some((k) => m.includes(String(k).toLowerCase()));
}

// Downgrade nudge (CLI only, notify-only). When account quota sits in the band
// [warnPct, hard block) AND the session is on a premium model, suggest dropping
// to a cheaper model. Hooks cannot switch the live model, so this only ever
// notifies -- it never blocks and never changes anything. Mirrors the desktop
// warn's own re-notify timestamp so it doesn't nag more than once per interval.
function computeDowngradeWarn({ config, status, prevState, now }) {
  let lastDowngradeWarnAt = (prevState && prevState.lastDowngradeWarnAt) || null;
  const dg = config.downgrade;
  if (!dg || dg.enabled !== true) return { lastDowngradeWarnAt };
  if (!isHighTierModel(status.model, dg.models)) return { lastDowngradeWarnAt };

  // Prefer the REAL per-model weekly cap (cached by hooks/statusline.js from the
  // rate_limits stdin block) over the single global plan% -- it tells us the
  // actual Opus/Sonnet quota, not an account-wide aggregate. Fall back to plan%
  // when no per-model signal has been cached yet.
  const modelWeekly = weeklyForModel(prevState && prevState.rateLimitByModel, status.model);
  const effectivePct = modelWeekly ? modelWeekly.pct : status.planPct;
  if (typeof effectivePct !== 'number') return { lastDowngradeWarnAt };

  const hardPlanPct = config.thresholds.plan * 100;
  // Below warnPct is fine; at/above the hard threshold the checkpoint block
  // already owns the moment, so only nudge inside the band between them.
  const inBand = effectivePct >= dg.warnPct && effectivePct < hardPlanPct;
  if (!inBand) return { lastDowngradeWarnAt };

  const last = lastDowngradeWarnAt ? new Date(lastDowngradeWarnAt).getTime() : 0;
  if (now - last >= RENOTIFY_INTERVAL_MS) {
    lastDowngradeWarnAt = new Date(now).toISOString();
    const pctShown = Math.round(effectivePct * 10) / 10;
    const scope = modelWeekly ? `Tu cuota semanal de ${status.model}` : 'Cuota';
    notify.send('Claude Quota Guardian', `${scope} al ${pctShown}% y estás en un modelo premium (${status.model}). Bajá a Sonnet con /model para estirar la cuota — Guardian no lo cambia solo.`, config);
  }
  return { lastDowngradeWarnAt };
}

// Compact one-line summary of every real quota window (session / weekly / per
// model) for notifications, so the user sees all of them at a glance -- e.g.
// "Sesión 11% · Semanal 68% · Fable 37%". Empty string when the API signal
// isn't available (falls back to the caller's own pct text).
function windowsSummary(status) {
  const api = status && status.apiUsage;
  if (!api || !api.available || !Array.isArray(api.windows) || !api.windows.length) return '';
  return api.windows.map((w) => `${w.label} ${Math.round(w.pct)}%`).join(' · ');
}

// Per-model (scoped) quota warning. Session + weekly_all gate every model and
// own the hard block; a scoped cap (e.g. Fable) only limits ONE model, so
// exhausting it should never halt the turn -- other models still work. This
// notifies (CLI only, throttled) when a scoped window enters [warnPct, 100],
// and never blocks.
function computeScopedWarn({ config, status, prevState, now }) {
  let scopedWarnedFor = (prevState && prevState.scopedWarnedFor) || null;
  const sc = config.scoped;
  if (!sc || sc.enabled === false) return { scopedWarnedFor };

  const api = status && status.apiUsage;
  const scoped = (api && api.available && Array.isArray(api.scoped)) ? api.scoped : [];
  const warnPct = typeof sc.warnPct === 'number' ? sc.warnPct : 85;
  const hot = scoped.filter((w) => typeof w.pct === 'number' && w.pct >= warnPct);
  if (!hot.length) return { scopedWarnedFor: null };

  // Notify ONCE per reset period per set of hot models, not on a repeating
  // timer. Keying on label + resetAt means: a new model going hot, or the same
  // model in a fresh weekly window, warns again -- but a model that just sits
  // maxed does not nag every turn for the rest of the week (there's nothing the
  // user can do; Guardian can't switch models and won't block on this).
  const key = hot.map((w) => `${w.label}:${w.resetAt || ''}`).sort().join('|');
  if (scopedWarnedFor === key) return { scopedWarnedFor };

  scopedWarnedFor = key;
  const parts = hot.map((w) => `${w.label} ${Math.round(w.pct)}%`).join(', ');
  notify.send('Claude Quota Guardian', `Límite por modelo cerca del tope: ${parts}. Ese modelo se pausa al llegar al 100%, pero podés seguir con otros modelos — Guardian no bloquea por esto.`, config);
  return { scopedWarnedFor };
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

  // Last exact reading from the OAuth usage endpoint, round-tripped through
  // state.json so lib/usage-api.js can throttle its refetches by age.
  const cachedApiUsage = (prevState && prevState.apiUsage && typeof prevState.apiUsage.pct === 'number')
    ? prevState.apiUsage
    : null;
  const prevPlanCheckCounter = (prevState && typeof prevState.planCheckCounter === 'number') ? prevState.planCheckCounter : 0;
  const thisPlanCheckCounter = prevPlanCheckCounter + 1;

  // Ring buffer of recent context% readings, round-tripped through state.json so
  // the predictive trigger (lib/usage-monitor) can fit a slope across checks.
  const now = Date.now();
  const prevSamples = (prevState && Array.isArray(prevState.predictSamples)) ? prevState.predictSamples : [];

  const status = getStatus({
    transcriptPath: input.transcript_path,
    config,
    cachedRateLimit: rateLimitPct !== null ? { pct: rateLimitPct, resetAt: rateLimitResetAt } : null,
    cachedPlan,
    planCheckCounter: thisPlanCheckCounter,
    cachedApiUsage,
    samples: prevSamples,
    now,
  });
  const entrypoint = status.entrypoint;
  const isCli = entrypoint === CLI_ENTRYPOINT;
  const isDesktop = entrypoint === DESKTOP_ENTRYPOINT;

  const planEnabled = config.plan !== 'none';
  const nextPlanCheckCounter = planEnabled ? (status.planUsage.due ? 0 : thisPlanCheckCounter) : 0;
  const cachedPlanPct = (planEnabled && status.planUsage.available) ? status.planUsage.pct : null;
  const cachedPlanResetAt = (planEnabled && status.planUsage.available) ? (status.planUsage.resetAt || null) : null;

  const maxPct = Math.max(
    status.contextPct == null ? 0 : status.contextPct,
    status.planPct == null ? 0 : status.planPct
  );

  const { lastDesktopWarnAt, lastDesktopPlanWarnAt } = isDesktop
    ? performDesktopWarn({ config, status, prevState })
    : {
      lastDesktopWarnAt: (prevState && prevState.lastDesktopWarnAt) || null,
      lastDesktopPlanWarnAt: (prevState && prevState.lastDesktopPlanWarnAt) || null,
    };

  const { lastDowngradeWarnAt } = isCli
    ? computeDowngradeWarn({ config, status, prevState, now })
    : { lastDowngradeWarnAt: (prevState && prevState.lastDowngradeWarnAt) || null };

  const { scopedWarnedFor } = isCli
    ? computeScopedWarn({ config, status, prevState, now })
    : { scopedWarnedFor: (prevState && prevState.scopedWarnedFor) || null };

  try {
    atomicWriteFileSync(statePath, JSON.stringify({
      maxPct: Math.round(maxPct * 10) / 10,
      contextPct: status.contextPct,
      planPct: status.planPct,
      // Predictive-trigger ring buffer + projection, carried forward so the
      // next check can fit a slope across readings (see lib/usage-monitor).
      predictSamples: status.predictSamples,
      projectedContextPct: status.projectedContextPct,
      contextSlopePerMin: status.contextSlopePerMin,
      rateLimitPct,
      rateLimitResetAt,
      planCheckCounter: nextPlanCheckCounter,
      cachedPlanPct,
      cachedPlanResetAt,
      apiUsage: (status.apiUsage && status.apiUsage.available) ? {
        pct: status.apiUsage.pct,
        resetAt: status.apiUsage.resetAt || null,
        fiveHour: status.apiUsage.fiveHour || null,
        sevenDay: status.apiUsage.sevenDay || null,
        // All real quota windows (session / weekly_all / per-model) + the scoped
        // subset, round-tripped so the throttled cached read and notifications
        // keep the full picture between live fetches.
        windows: status.apiUsage.windows || null,
        scoped: status.apiUsage.scoped || null,
        topWindow: status.apiUsage.topWindow || null,
        fetchedAt: status.apiUsage.fetchedAt || null,
      } : cachedApiUsage,
      sessionId: input.session_id || null,
      entrypoint,
      model: status.model,
      lastDesktopWarnAt,
      lastDesktopPlanWarnAt,
      lastDowngradeWarnAt,
      scopedWarnedFor,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {
    // heartbeat is best-effort: never block the hook on a failed state write
  }

  // Enforcement is terminal-only: Desktop already got its notify-only warns
  // above, every other non-CLI surface is silent -- either way, no pending
  // checkpoint and no block past this point.
  if (!isCli) return null;

  // "Continuar bajo mi riesgo": an unexpired override suppresses pending
  // creation and the block, but the heartbeat above still flows so the watcher
  // keeps tracking. The block returns on its own once the override expires.
  if (override.isActive(input.cwd, now)) return null;

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
    const summary = windowsSummary(status);
    notify.send('Claude Quota Guardian', summary
      ? `Cuota al límite (${summary}) — guardando progreso...`
      : `Uso al ${pctShown}% — guardando progreso...`, config);
  } else {
    // Still above threshold and not yet checkpointed: re-notify periodically
    // instead of going silent after the one easily-missed initial toast.
    // Once checkpointFile is set the work IS saved -- stop nagging; the
    // pending just waits for its SessionStart consumption.
    const last = pending.lastNotifiedAt ? new Date(pending.lastNotifiedAt).getTime() : 0;
    if (!pending.checkpointFile && Date.now() - last >= RENOTIFY_INTERVAL_MS) {
      const refreshed = { ...pending, lastNotifiedAt: new Date().toISOString() };
      atomicWriteFileSync(pendingFile, JSON.stringify(refreshed, null, 2));
      const pct = pending.pctAtTrigger || {};
      const pctShown = Math.max(pct.context || 0, pct.plan || 0);
      const summary = windowsSummary(status);
      notify.send('Claude Quota Guardian', summary
        ? `Seguís al límite (${summary}) — falta /continuity-checkpoint.`
        : `Seguís sobre el umbral (${pctShown}%) — falta /continuity-checkpoint.`, config);
    }
  }

  return blockReason(status.triggeredBy);
}

module.exports = { performCheck, computeDowngradeWarn, isHighTierModel, RENOTIFY_INTERVAL_MS };
