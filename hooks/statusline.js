#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');

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

function isoFromEpochSeconds(seconds) {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

// rate_limits is the only place Claude Code exposes real, account-wide Pro/Max
// quota (5h/7d) -- it never appears in PreToolUse/PostToolUse/Stop payloads,
// only here. Cache the more-pressing window into the same per-project
// state.json the other hooks heartbeat into, so lib/threshold-check.js can
// react to it on its own next run without this script needing to know
// anything about pending checkpoints or block decisions itself.
function cacheRateLimit(cwd, rateLimits) {
  if (!cwd || !rateLimits) return;

  const windows = [rateLimits.five_hour, rateLimits.seven_day]
    .filter((w) => w && typeof w.used_percentage === 'number');
  if (windows.length === 0) return;

  const top = windows.reduce((a, b) => (b.used_percentage > a.used_percentage ? b : a));

  try {
    const statePath = paths.statePath(cwd);
    const prev = readJsonSafe(statePath) || {};
    atomicWriteFileSync(statePath, JSON.stringify({
      ...prev,
      rateLimitPct: top.used_percentage,
      rateLimitResetAt: isoFromEpochSeconds(top.resets_at),
      updatedAt: new Date().toISOString(),
    }, null, 2));
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
