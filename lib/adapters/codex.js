'use strict';

// Notify-only adapter for OpenAI Codex CLI. Codex has no hook system, so the
// full Guardian loop (detect -> block -> checkpoint -> auto-resume) is not
// possible there. What IS possible: its rollout files under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl record, per session,
// - a first `session_meta` line with the project cwd, and
// - periodic `token_count` events whose `info.last_token_usage.total_tokens`
//   vs `info.model_context_window` is the real context usage of the last
//   request, plus optional account `rate_limits` (used_percent) when on a
//   subscription.
// The watcher polls this read-only and notifies the user to save/summarize
// before the cutoff -- it never blocks and never writes into ~/.codex.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STALENESS_MS = 20 * 60 * 1000;
const DEFAULT_MAX_FILES = 10;

// Rollouts are sharded by date; a fresh session file can only live in
// today's or yesterday's directory, so only those two are walked.
function dateDirs(root, now) {
  const dirs = [];
  for (const offset of [0, 1]) {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dirs.push(path.join(root, 'sessions', y, m, day));
  }
  return dirs;
}

function findRecentRollouts(root, { now = new Date(), stalenessMs = DEFAULT_STALENESS_MS, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const found = [];
  for (const dir of dateDirs(root, now)) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (now.getTime() - stat.mtimeMs > stalenessMs) continue;
      found.push({ file, mtimeMs: stat.mtimeMs });
    }
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);
}

function maxRateLimitPct(rateLimits) {
  if (!rateLimits) return null;
  let max = null;
  for (const w of [rateLimits.primary, rateLimits.secondary]) {
    if (w && typeof w.used_percent === 'number' && (max === null || w.used_percent > max)) {
      max = w.used_percent;
    }
  }
  return max;
}

// One backward pass for usage, one forward line for the session meta.
function readSessionUsage(file, mtimeMs) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;

  let meta = null;
  try {
    const first = JSON.parse(lines[0]);
    if (first && first.type === 'session_meta' && first.payload) meta = first.payload;
  } catch {
    // meta stays null; usage may still be readable
  }

  let contextPct = null;
  let contextWindow = null;
  let rateLimitPct = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const p = entry && entry.payload;
    if (!p || p.type !== 'token_count') continue;

    if (rateLimitPct === null) rateLimitPct = maxRateLimitPct(p.rate_limits);

    const info = p.info;
    if (contextPct === null && info && info.last_token_usage
        && typeof info.last_token_usage.total_tokens === 'number'
        && typeof info.model_context_window === 'number'
        && info.model_context_window > 0) {
      contextPct = (info.last_token_usage.total_tokens / info.model_context_window) * 100;
      contextWindow = info.model_context_window;
    }

    if (contextPct !== null && rateLimitPct !== null) break;
  }

  if (contextPct === null && rateLimitPct === null) return null;

  const projectPath = (meta && meta.cwd) || null;
  return {
    provider: 'codex',
    file,
    sessionId: (meta && (meta.session_id || meta.id)) || null,
    projectPath,
    projectName: projectPath ? path.basename(projectPath) : null,
    contextPct: contextPct === null ? null : Math.round(contextPct * 10) / 10,
    contextWindow,
    rateLimitPct: rateLimitPct === null ? null : Math.round(rateLimitPct * 10) / 10,
    maxPct: Math.round(Math.max(contextPct || 0, rateLimitPct || 0) * 10) / 10,
    updatedAt: new Date(mtimeMs).toISOString(),
  };
}

// Live usage of every fresh Codex session. Read-only over ~/.codex.
function readCodexUsage({ root, now = new Date(), stalenessMs = DEFAULT_STALENESS_MS, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const sessions = [];
  for (const { file, mtimeMs } of findRecentRollouts(root, { now, stalenessMs, maxFiles })) {
    const usage = readSessionUsage(file, mtimeMs);
    if (usage) sessions.push(usage);
  }
  return sessions;
}

module.exports = { findRecentRollouts, readSessionUsage, readCodexUsage, DEFAULT_STALENESS_MS };
