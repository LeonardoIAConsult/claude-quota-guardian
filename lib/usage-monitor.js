'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const PLAN_LIMITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan-limits.json'), 'utf8'));
const usageApi = require('./usage-api');

function contextLimitForModel(model) {
  if (model && PLAN_LIMITS.context[model] != null) return PLAN_LIMITS.context[model];
  return PLAN_LIMITS.context.default;
}

// Single backward pass over the transcript for both pieces it's read for --
// context usage and entrypoint -- since context-window checks run on every
// PostToolUse/Stop and previously paid for two full reads+splits of the same
// (potentially large, ever-growing) file per check.
function getContextAndEntrypoint(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { pct: null, error: 'transcript-unreadable', entrypoint: null };
  }

  let entrypoint = null;
  let contextResult = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (entrypoint === null && entry && entry.entrypoint) entrypoint = entry.entrypoint;

    if (contextResult === null) {
      const usage = entry && entry.message && entry.message.usage;
      if (usage) {
        const used = (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0);
        const model = entry.message.model || null;
        const limit = contextLimitForModel(model);
        contextResult = { pct: (used / limit) * 100, used, limit, model };
      }
    }

    if (entrypoint !== null && contextResult !== null) break;
  }

  return { ...(contextResult || { pct: null, error: 'no-usage-found' }), entrypoint };
}

function getContextUsage(transcriptPath) {
  const { entrypoint, ...rest } = getContextAndEntrypoint(transcriptPath);
  return rest;
}

// Claude Code stamps every transcript line with the surface that produced it
// ("cli", "claude-desktop", ...).
function getEntrypoint(transcriptPath) {
  return getContextAndEntrypoint(transcriptPath).entrypoint;
}

function runCcusage(args) {
  try {
    // shell:true so Windows resolves `npx.cmd` via PATHEXT — Node >=20 refuses to
    // spawn .cmd/.bat without a shell (CVE-2024-27980). `ccusage` (not @latest) uses
    // a global install if present and still falls back to npx fetch otherwise.
    const out = cp.execFileSync('npx', ['ccusage', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      windowsHide: true,
      shell: true,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function getPlanUsage(planType, planTokenLimit) {
  if (!planType || planType === 'none') {
    return { available: false, reason: 'plan-none' };
  }

  const data = runCcusage(['blocks', '--json', '--active', '--token-limit', 'max']);
  if (!data || !Array.isArray(data.blocks) || data.blocks.length === 0) {
    return { available: false, reason: 'ccusage-unavailable' };
  }

  const block = data.blocks[0];
  const resetAt = block.endTime || null;

  // Old ccusage (<20) returned a precomputed tokenLimitStatus.percentUsed.
  const status = block.tokenLimitStatus;
  if (status && typeof status.percentUsed === 'number') {
    return { available: true, pct: status.percentUsed, resetAt };
  }

  // ccusage >=20 only reports raw totalTokens. Anthropic does not publish the
  // exact 5h token cap, so a percentage is only meaningful when the user supplies
  // a token budget via config (planTokenLimit). Without it, plan-quota % is
  // unavailable and the context guard is the sole trigger.
  if (typeof planTokenLimit === 'number' && planTokenLimit > 0 && typeof block.totalTokens === 'number') {
    return { available: true, pct: (block.totalTokens / planTokenLimit) * 100, resetAt };
  }

  return { available: false, reason: 'no-limit-data', resetAt };
}

// ccusage is a subprocess (npx + shell, 1-2s typical, 15s worst case) -- too
// slow to shell out to on every single PostToolUse/Stop check. Reuse the last
// known reading until `intervalToolCalls` checks have passed since the last
// real ccusage call (tracked by the caller via `counter`/`cachedPlan`, both
// round-tripped through state.json since this module is stateless).
function getThrottledPlanUsage({ planType, planTokenLimit, intervalToolCalls, counter, cachedPlan }) {
  if (!planType || planType === 'none') return { available: false, reason: 'plan-none', due: false };

  const interval = Math.max(1, intervalToolCalls || 1);
  const due = !cachedPlan || (counter || 0) >= interval;
  if (!due) return { ...cachedPlan, due: false };

  const fresh = getPlanUsage(planType, planTokenLimit);
  if (fresh.available) return { ...fresh, due: true };
  return { ...(cachedPlan || fresh), due: true };
}

// Predictive trigger. Fit a least-squares slope to recent context% samples
// (each {pct, ts}) and project it `leadSeconds` into the future. Returns a hit
// only when the projection crosses the hard threshold while the CURRENT reading
// is still below it -- a genuine "about to hit the wall" signal, never a
// duplicate of the real-threshold path. Pure and time-injected (`now`) so it is
// deterministic under test. `samples` is the prior ring buffer; the returned
// `samples` is it with the current reading appended, windowed, and capped.
function projectContext({ samples, now, contextPct, config }) {
  const pred = config && config.predictive;
  const maxSamples = (pred && pred.maxSamples) || 8;
  const passthrough = Array.isArray(samples) ? samples.slice(-maxSamples) : [];
  if (!pred || pred.enabled !== true || contextPct === null || typeof now !== 'number') {
    return { hit: false, projectedPct: null, slopePerMin: null, samples: passthrough };
  }

  const windowMs = (pred.windowSeconds || 300) * 1000;
  const minSamples = pred.minSamples || 3;
  const leadMs = (pred.leadSeconds || 90) * 1000;

  const next = [...(Array.isArray(samples) ? samples : []), { pct: contextPct, ts: now }]
    .filter((s) => s && typeof s.pct === 'number' && typeof s.ts === 'number'
      && s.ts <= now && now - s.ts <= windowMs)
    .slice(-maxSamples);

  if (next.length < minSamples) {
    return { hit: false, projectedPct: null, slopePerMin: null, samples: next };
  }

  const n = next.length;
  const t0 = next[0].ts;
  const xs = next.map((s) => s.ts - t0);
  const ys = next.map((s) => s.pct);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den; // pct per ms
  const slopePerMin = slope * 60000;
  const thresholdPct = config.thresholds.context * 100;

  if (slope <= 0) {
    return { hit: false, projectedPct: contextPct, slopePerMin, samples: next };
  }

  const projectedPct = contextPct + slope * leadMs;
  const hit = contextPct < thresholdPct && projectedPct >= thresholdPct;
  return { hit, projectedPct, slopePerMin, samples: next };
}

function getStatus({ transcriptPath, config, cachedRateLimit, cachedPlan, planCheckCounter, cachedApiUsage, samples = [], now = Date.now() }) {
  const ctx = getContextAndEntrypoint(transcriptPath);
  const contextPct = ctx.pct;
  const entrypoint = ctx.entrypoint;

  // Exact account-wide usage from Anthropic's OAuth usage endpoint -- the
  // authoritative version of the signal ccusage estimates and the statusline
  // caches. Gated on `enabled === true` (not just truthy config) so bare
  // hand-built configs, as in tests, never reach the network.
  const apiCfg = config.usageApi || {};
  const apiUsage = apiCfg.enabled === true
    ? usageApi.getThrottledUsage({
      cacheSeconds: apiCfg.cacheSeconds,
      timeoutMs: apiCfg.timeoutMs,
      cachedApi: cachedApiUsage,
    })
    : { available: false, reason: 'disabled', due: false };

  // While the API answers, the ccusage subprocess is pure overhead -- skip it.
  const planUsage = apiUsage.available
    ? { available: false, reason: 'api-active', due: false }
    : getThrottledPlanUsage({
      planType: config.plan,
      planTokenLimit: config.planTokenLimit,
      intervalToolCalls: config.planCheckIntervalToolCalls,
      counter: planCheckCounter,
      cachedPlan,
    });

  let planPct = apiUsage.available ? apiUsage.pct : (planUsage.available ? planUsage.pct : null);
  let planResetAt = apiUsage.available
    ? (apiUsage.resetAt || null)
    : (planUsage.available ? (planUsage.resetAt || null) : null);

  // Real account-wide quota (Claude.ai Pro/Max rate_limits.five_hour/seven_day),
  // cached from hooks/statusline.js since PostToolUse/Stop hooks never receive it
  // directly. Works for any Pro/Max subscriber with no ccusage/planTokenLimit
  // setup, so it can win over -- or fill in for -- the ccusage-derived plan%.
  if (cachedRateLimit && typeof cachedRateLimit.pct === 'number' && (planPct === null || cachedRateLimit.pct > planPct)) {
    planPct = cachedRateLimit.pct;
    planResetAt = cachedRateLimit.resetAt || planResetAt;
  }

  const contextHit = contextPct !== null && (contextPct / 100) >= config.thresholds.context;
  const planHit = planPct !== null && (planPct / 100) >= config.thresholds.plan;

  // Only counts when the current context reading is still below the hard
  // threshold (projectContext enforces that) -- a real contextHit takes over.
  const prediction = projectContext({ samples, now, contextPct, config });
  const predictedHit = prediction.hit === true;

  let triggeredBy = null;
  if (contextHit && planHit) triggeredBy = 'both';
  else if (contextHit) triggeredBy = 'context';
  else if (planHit) triggeredBy = 'plan';
  else if (predictedHit) triggeredBy = 'context-predicted';

  return {
    contextPct,
    planPct,
    planResetAt,
    entrypoint,
    model: ctx.model || null,
    planUsage,
    apiUsage,
    anyAtThreshold: contextHit || planHit || predictedHit,
    triggeredBy,
    predictedContextHit: predictedHit,
    projectedContextPct: prediction.projectedPct,
    contextSlopePerMin: prediction.slopePerMin,
    predictSamples: prediction.samples,
  };
}

module.exports = { getContextUsage, getPlanUsage, getThrottledPlanUsage, getStatus, getEntrypoint, projectContext };
