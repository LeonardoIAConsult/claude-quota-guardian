'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const PLAN_LIMITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan-limits.json'), 'utf8'));

function contextLimitForModel(model) {
  if (model && PLAN_LIMITS.context[model] != null) return PLAN_LIMITS.context[model];
  return PLAN_LIMITS.context.default;
}

function getContextUsage(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { pct: null, error: 'transcript-unreadable' };
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const usage = entry && entry.message && entry.message.usage;
    if (!usage) continue;

    const used = (usage.input_tokens || 0)
      + (usage.cache_read_input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0);
    const model = entry.message.model || null;
    const limit = contextLimitForModel(model);

    return { pct: (used / limit) * 100, used, limit, model };
  }

  return { pct: null, error: 'no-usage-found' };
}

// Claude Code stamps every transcript line with the surface that produced it
// ("cli", "claude-desktop", ...). Read backwards same as getContextUsage so a
// truncated/compacted transcript still resolves from whatever lines remain.
function getEntrypoint(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry && entry.entrypoint) return entry.entrypoint;
  }

  return null;
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

function getStatus({ transcriptPath, config }) {
  const ctx = getContextUsage(transcriptPath);
  const contextPct = ctx.pct;

  let planPct = null;
  let planResetAt = null;
  if (config.plan !== 'none') {
    const plan = getPlanUsage(config.plan, config.planTokenLimit);
    if (plan.available) {
      planPct = plan.pct;
      planResetAt = plan.resetAt;
    }
  }

  const contextHit = contextPct !== null && (contextPct / 100) >= config.thresholds.context;
  const planHit = planPct !== null && (planPct / 100) >= config.thresholds.plan;

  let triggeredBy = null;
  if (contextHit && planHit) triggeredBy = 'both';
  else if (contextHit) triggeredBy = 'context';
  else if (planHit) triggeredBy = 'plan';

  return {
    contextPct,
    planPct,
    planResetAt,
    anyAtThreshold: contextHit || planHit,
    triggeredBy,
  };
}

module.exports = { getContextUsage, getPlanUsage, getStatus, getEntrypoint };
