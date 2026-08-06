'use strict';

// Parse Claude Code's stdin `rate_limits` block into Guardian's shape.
//
// Technique + robustness ported from claude-pulse (MIT, audited clean
// 2026-08-04) and its regression suite: each window is guarded on its own so
// one malformed window never drops the rest; `resets_at` accepts epoch SECONDS
// or an ISO string, and a bad value keeps the window (resetAt=null) rather than
// discarding it; per-model weekly caps are discovered generically from
// `seven_day_<model>` keys, so a new model tier needs no code change here.

function isoFromResetsAt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v * 1000); // Claude Code sends epoch seconds
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function windowFrom(w) {
  if (!w || typeof w !== 'object' || typeof w.used_percentage !== 'number') return null;
  return { pct: w.used_percentage, resetAt: isoFromResetsAt(w.resets_at) };
}

// Returns { top, byModel }:
//   top     = {pct, resetAt} of the more-pressing account window (5h vs 7d), or null
//   byModel = { <suffix>: {pct, resetAt} } for each seven_day_<model> weekly cap
function parseRateLimits(rl) {
  const result = { top: null, byModel: {} };
  if (!rl || typeof rl !== 'object') return result;

  const account = [windowFrom(rl.five_hour), windowFrom(rl.seven_day)].filter(Boolean);
  if (account.length) {
    result.top = account.reduce((a, b) => (b.pct > a.pct ? b : a));
  }

  for (const [key, val] of Object.entries(rl)) {
    if (key === 'seven_day' || !key.startsWith('seven_day_')) continue;
    const w = windowFrom(val);
    if (w) result.byModel[key.slice('seven_day_'.length)] = w;
  }
  return result;
}

// Coarse tier family for a model id, matched against byModel keys.
function modelTier(modelId) {
  if (!modelId) return null;
  const m = String(modelId).toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'fable'].find((t) => m.includes(t)) || null;
}

// Weekly cap for the model in use, if the stdin payload carried one. Prefers an
// exact tier key (seven_day_opus), else the first key starting with that tier
// (seven_day_sonnet_4_6).
function weeklyForModel(byModel, modelId) {
  const tier = modelTier(modelId);
  if (!tier || !byModel || typeof byModel !== 'object') return null;
  if (byModel[tier]) return byModel[tier];
  const hit = Object.keys(byModel).find((k) => k.startsWith(tier));
  return hit ? byModel[hit] : null;
}

module.exports = { parseRateLimits, modelTier, weeklyForModel, isoFromResetsAt, windowFrom };
