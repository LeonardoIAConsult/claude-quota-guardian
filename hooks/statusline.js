#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const { parseRateLimits } = require('../lib/rate-limits');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// rate_limits is the only place Claude Code exposes real, account-wide Pro/Max
// quota (5h/7d AND per-model weekly caps) -- it never appears in
// PreToolUse/PostToolUse/Stop payloads, only here. Cache the more-pressing
// account window PLUS the per-model weekly caps into the same per-project
// state.json the other hooks heartbeat into, so lib/threshold-check.js can
// react to them on its own next run: the account window drives the block, the
// per-model caps let the downgrade nudge use the real Opus/Sonnet quota instead
// of a single global number.
function cacheRateLimit(cwd, rateLimits) {
  if (!cwd || !rateLimits) return;

  const { top, byModel } = parseRateLimits(rateLimits);
  if (!top && Object.keys(byModel).length === 0) return;

  try {
    const statePath = paths.statePath(cwd);
    const prev = readJsonSafe(statePath) || {};
    const next = { ...prev, updatedAt: new Date().toISOString() };
    if (top) {
      next.rateLimitPct = top.pct;
      next.rateLimitResetAt = top.resetAt;
    }
    if (Object.keys(byModel).length > 0) {
      next.rateLimitByModel = byModel;
    }
    atomicWriteFileSync(statePath, JSON.stringify(next, null, 2));
  } catch {
    // cache write is best-effort: the status line still renders below regardless
  }
}

function renderLine(input) {
  const model = (input.model && (input.model.display_name || input.model.id)) || 'Claude';
  const rl = input.rate_limits || {};
  const fiveHour = rl.five_hour && typeof rl.five_hour.used_percentage === 'number'
    ? `${Math.round(rl.five_hour.used_percentage)}%` : '--';
  const sevenDay = rl.seven_day && typeof rl.seven_day.used_percentage === 'number'
    ? `${Math.round(rl.seven_day.used_percentage)}%` : '--';
  const ctxPct = input.context_window && typeof input.context_window.used_percentage === 'number'
    ? `${Math.round(input.context_window.used_percentage)}%` : '--';

  return `${model} | ctx ${ctxPct} | 5h ${fiveHour} 7d ${sevenDay}`;
}

function main() {
  const input = readStdin();
  if (!input) {
    process.stdout.write('');
    return;
  }

  const cwd = input.cwd || (input.workspace && input.workspace.current_dir) || null;
  cacheRateLimit(cwd, input.rate_limits);

  process.stdout.write(renderLine(input));
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[statusline] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
  process.stdout.write('');
}
